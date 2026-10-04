# Reconcile Guidance and Verify the Installed Author Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach Sheg agents to design studies with meaningful variation, prove the shipped skills in pressure scenarios that use real Sheg tools where required, and keep versioned plugin outputs generated from one authored product version.

**Architecture:** Treat respondent profile, stimulus, question/response, and state as the substantive variation dimensions; matching all four is a duplicate for study-design coverage. Keep each skill's versioned scenarios and evaluators beside its source, keep deterministic campaign-harness tests in `test/`, and keep all live campaign data off-repository and disposable. Use root `package.json` as the only authored product-version source and have the build synchronize every downstream version surface.

**Tech Stack:** TypeScript, Node.js 24 `node:sqlite`, Codex MCP, JSON skill scenarios, the repository skill-campaign harness, generated marketplace package.

**Spec:** `.agents/plans/v0.3.0-dogfood-improvements/roadmap.md`, Plan 10, `.agents/specs/2026-10-02-v0.3.0-dogfood-improvements.md`, and `.agents/doctrine/skill-behavior-testing.md`.

**Execution Strategy:** `executing-plans` inline; the first commit retires the merged Plan 9 child artifact and corrects the live roadmap, then implementation proceeds in this same PR.

**Base:** `develop` after PR #21, commit `d77c4ebbbd978624e3934b104e7f68216f24155c`.

**Feature target:** `develop`, product version `0.3.0-dev.12` from root `package.json`; generated version surfaces must be produced by `npm run build`.

**Scope:** Reconcile study-design and polling guidance with the approved variation principle; add pressure scenarios and evaluators for duplicate inputs and meaningful cohort/profile coverage; make the selected-material workflow fixture seed deterministic source evidence into each attempt-owned store so real `run_query` and `run_inspect` calls can be exercised without inference; ensure package version outputs derive from root `package.json`; verify final guidance and package behavior using transient campaigns and deterministic checks; retire the completed Plan 9 artifact and repair roadmap state and links.

**Invariants:** The cohort supplies respondent-profile variation and is sized for the meaningful perspectives the decision requires, not minimized by default. Repeating exact inputs may test behavior stability or recovery but does not create substantive study coverage. Do not add runtime duplicate blocking, universal tool isolation, hooks, telemetry, permanent tool auditing, provider inference, or a release tag. Keep scenario fixtures and deterministic harness tests in source; never commit actor/judge outputs, live run databases, campaign reports, or development receipts.

## Task 1: Retire merged Plan 9 and align the live roadmap

- [x] Confirm PR #21 merged to `develop` at `d77c4ebbbd978624e3934b104e7f68216f24155c` and the full Plan 9 scope is present in implementation, tests, ADR-0027, and release guidance.
- [x] Remove `.agents/plans/v0.3.0-dogfood-improvements/09-datastore-upgrade-compatibility.md`, update roadmap status/worktree/base/table to Plan 9 merged and Plan 10 active, and remove the completed Plan 9 detail now governed by the ADR and release guide.
- [x] Add this JIT Plan 10 before implementation; keep the active parent roadmap and broader dogfood specification.

## Task 2: Generate every product-version copy from the authored version

- [x] Add failing unit coverage showing that a changed `package.json` version regenerates the two root `package-lock.json` version fields, `plugin.json`, `dist/` runtime identity, and `plugins/sheg/` package metadata while preserving unrelated lockfile data.
- [x] Implement the narrow deterministic version synchronizer and call it from the supported build path; do not duplicate a version literal or require agents to hand-align generated files.
- [x] Update `docs/guides/releases.md` and `.agents/playbooks/semver-version-alignment.md` to direct contributors to change only root `package.json`, run the build, inspect generated diffs, and use release validation to catch stale outputs.
- [x] Set the intentional target version to `0.3.0-dev.12` through the authored source and regenerate all derived version surfaces.

## Task 3: Align canonical study-design and polling guidance

- [x] Replace wording that implies the study, question set, or cohort should be minimized by default with guidance to keep the design focused while covering every meaningful input difference the author wants to understand.
- [x] State in `skills/study-design/SKILL.md` and `skills/stimulus-response-polling/SKILL.md` that respondents, stimulus, question/response, and state are the four substantive variation levers; the cohort is the source of profile variation; matching across the four dimensions is duplicate input.
- [x] Explain that rerunning an identical fingerprint may sample ordinary model variability but adds no substantive coverage; reserve exact repeats for explicit stability or recovery checks and keep those purposes distinct from study design.
- [x] Preserve useful boundaries such as exact authored material units, focused question selection, provider call limits, and the agent's role in designing rather than inferring editorial boundaries.

## Task 4: Add source-owned pressure scenarios and usable tool-backed fixture state

- [x] Add a `study-design` pressure scenario and evaluator for an agent tempted to repeat the same cohort/stimulus/question/state or shrink the cohort; require a concrete variation plan spanning all four dimensions and profile coverage tied to the user's decision.
- [x] Strengthen the polling variation scenario or add a distinct case that tests duplicate-input recognition, a one-dimension purposeful change, no-fit handling, and useful respondent-profile coverage; increment paired scenario/evaluator versions together.
- [x] Extend the workflow setup contract and deterministic seed support for selected-material follow-on so the scenario's exact source run, mapped Choice answers, no-fit respondent, and material snapshots exist in the attempt-owned database before the actor starts.
- [x] Add deterministic `test/skill-testing/` coverage for seed integrity and MCP queries against that fixture; preserve checkpoint order and assert the workflow uses `run_query` and `run_inspect` without starting inference.

## Task 5: Run focused fresh-context pressure campaigns and inspect them

- [x] Select affected owning-skill cases and shared safeguards with `npm run skill:campaign -- select`; compare `develop` baseline guidance against candidate package guidance under identical scenario, evidence, rubric, actor settings, and runtime identities.
- [x] Run fresh guided actors for the new study-design variation case, polling variation/selected-material case, and existing partial-journey recovery safeguard; use the selected-material workflow with its seeded attempt-owned store so required Sheg MCP calls are observed.
- [x] Use no-guidance only as a separate attribution control; record repetition rationale in the off-repository campaign configuration, prioritize scenario breadth, and use repeats only to assess response stability or investigate disagreement.
- [x] Inspect every failure, uncertain judgment, runtime error, missing model/runtime metadata, and judge disagreement; rerun only after a substantive scenario, prompt, runtime, or harness correction.
- [x] Keep configs and outputs under `Z:/_agent-scratch/sheg/` or another off-repository temporary directory; review and discard each campaign with `npm run skill:campaign -- discard` before publication.

## Task 6: Verify the final package and release paths

- [x] Build the generated plugin package and local candidate ZIP from `plugins/sheg/`; prove the current prerelease version is consistent and the archive has exactly the generated package contents.
- [x] Run copied-package MCP startup, worker lifecycle, and credential-helper checks without repository files, local builds, or dependency installation; retain only deterministic source tests, not runtime receipts.
- [x] Exercise stable-version package validation with synthetic test inputs only; do not create a stable tag, GitHub Release, or publication.
- [x] Run focused harness/scenario-catalog tests, `npm run build`, `npm run verify`, and `git diff --check`; inspect generated skill/package parity and ensure campaign tests stay outside CI and pre-commit.

## Task 7: Review, publish, and close out

- [ ] Request a fresh whole-branch review after implementation and correct every actionable finding before publication.
- [ ] Push the feature branch, open a PR targeting `develop`, and merge only after the fresh review and required hosted check pass.
- [ ] Verify merge ancestry and PR head identity, retire this worktree and local branch using the repository worktree cleanup helper, and preserve Plan 10 through its own merge for retirement by the next substantive slice.

**Key files:** `skills/study-design/SKILL.md`, `skills/study-design/tests/behavior/scenarios.json`, `skills/study-design/tests/behavior/evaluators.json`, `skills/stimulus-response-polling/SKILL.md`, its behavior scenarios/evaluators/workflows, `scripts/skill-testing/workflow-seeds.ts`, `scripts/skill-testing/contracts.ts`, `scripts/skill-testing/runner.ts`, `scripts/generate-plugin-manifest.ts`, `scripts/build.ts`, `scripts/check-generated.ts`, `test/skill-testing/`, `docs/guides/releases.md`, `.agents/playbooks/semver-version-alignment.md`, `package.json`, generated manifests/runtime/package, and the live roadmap.

**Non-goals:** Implement input deduplication in the Sheg runtime; add a permanent hook, telemetry, tool isolation, or universal tool-use audit; perform provider inference for pressure fixtures; retain campaign results in source; publish a release or change marketplace/plugin identity.

**Review Focus:** Verify all user-facing guidance distinguishes substantive input variation from repeated-run stability checks, the cohort covers purposeful respondent-profile differences, live tool checkpoints operate on real deterministic attempt-owned Sheg storage, `package.json` alone determines every generated product-version field, pressure-test results remain transient, and Plan 9 is retired without removing active roadmap/spec content.
