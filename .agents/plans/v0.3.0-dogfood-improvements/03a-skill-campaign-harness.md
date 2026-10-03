# Repeatable Skill Campaign Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sheg skill experiments reproducible, resumable, contract-aware, and reviewable across discovery, focused behavior, and scripted workflows.

**Architecture:** Extend the existing prompt/catalog seam with a frozen campaign manifest, an append-only trial runner, a Codex process adapter, layered graders, and a static comparison report. Keep deterministic verification independent of live agent dispatch. Preserve the existing scenario CLI and its ability to read externally supplied trace wrappers; keep reusable scenario/evaluator fixtures in source and rely on Git history for prior development results.

**Tech Stack:** TypeScript, Zod, Node test runner, Node child processes, installed Codex CLI, JSON/JSONL, static HTML and Markdown reports. No new evaluation framework dependency.

**Spec:** [Approved harness scope](../../specs/2026-10-03-skill-campaign-harness.md). Read `.agents/runbooks/implementing.md`, the Gitflow and version playbooks, and the current harness source before execution.

**Execution Strategy:** `executing-plans` - frozen identities, retry state, grading records, and report comparability share contracts across tasks. Inline implementation maintains those invariants; fresh scenario actors/evaluators and whole-branch review provide independent checks.

**Status:** Implementation in progress; Tasks 1-5 are implemented, and Task 6 remains in proof, review, and publication. Plan 4 is paused. Its completed product commits are not dependencies of this plan.

**Target development version:** `0.3.0-dev.5`, based on latest `develop` after Plan 3. Use `/using-git-worktrees` and its bundled script for a fresh canonical `codex/skill-campaign-harness` worktree. Leave `codex/v0.3.0-selected-stimulus` intact. Do not merge Plan 4 product changes into Plan 3a.

## Current implementation and custody

`scripts/skill-scenario.ts` renders prompts and validates catalog pairing, reference containment, actor/evaluator shape, and stored trace identity. It does not dispatch or grade agents. `test/skill-scenario-harness.test.ts` has bespoke evidence checks for two named campaigns. `test/release-package.test.ts` proves skill-local tests are excluded from the plugin. These are the starting points, not claims of a complete campaign runner.

Existing skill scenarios and evaluators stay under `skills/{study-design,stimulus-response-polling}/tests/behavior/`; prior baseline/campaign results are represented by Git history and are not source fixtures. Shared harness modules will live under `scripts/skill-testing/`: `contracts.ts`, `snapshots.ts`, `runner.ts`, `codex-adapter.ts`, `graders.ts`, `report.ts`, and `cli.ts`, each owning its named responsibility. Shared deterministic tests live under `test/skill-testing/`. Preserve `npm run skill:scenario`; add `npm run skill:campaign` pointing at `cli.ts`.

Plan 4 has completed Tasks 1-3 through `f09978f`, with 366 tests passing at that checkpoint; Task 4 has preliminary actor outputs but no finished campaign. Its uncommitted posture doctrine and AGENTS pointer are inputs for this plan, not implemented harness features. Incorporate corrected posture documentation in Task 5. Do not preserve or relabel historical campaign outputs as source artifacts.

## Review Focus

- Resume after a crash between output capture and grading must not dispatch an already completed trial again.
- A changed prompt, rubric, snapshot, or execution setting must block an invalid old/new comparison or resume.
- Invalid JSON, wrong scenario identity, timeout, judge failure, and an actual behavior failure must retain separate outcomes.
- A persuasive explanation with an invalid request must fail the deterministic grader without hiding useful semantic observations.
- Discovery and workflow trials must not accidentally receive evaluator rubrics, hidden future turns, or old/new labels.
- Guided workflow actors must receive their frozen selected guidance while future turns remain hidden, and the hash must represent the exact dispatched prompt sequence.
- Deterministic selected-material checks must reject no-fit and mismatched material packets; historical grading must use the frozen scenario basis and recover from retained evaluator output.
- Comparisons must include timeout, concurrency, adapter/runtime identity, and guided-arm constraints; Codex capability gaps must fail preflight before actor dispatch.

## Task 1: Freeze campaign contracts and snapshots

**Files:** Create `contracts.ts`, `snapshots.ts`, and `test/skill-testing/campaign-contracts.test.ts`; adapt `scripts/skill-scenario.ts` only where reuse requires exported pure helpers.

**Interfaces:** Export `prepareCampaign(config, outputRoot)` returning a frozen manifest. Config names campaign ID, selected scenario/version, suite kind, capability/regression tag, repetitions, arms (`old`, `candidate`, optional `no-guidance`), skill source paths, actor/evaluator execution settings, concurrency, timeout, and output root. Manifest stores hashes for request/evidence/criteria, skill descriptions/body/references, adapter version, and requested configuration. Trial IDs derive from scenario, arm, and repetition; attempt IDs are distinct. Comparison requires matching request, evidence, criteria, and execution settings, with skill snapshot the intentional arm difference.

- [ ] Write behavioral tests: modifying a reference after preparation leaves the frozen prompt unchanged; mismatched criteria/configuration blocks comparison; missing references and duplicate trial IDs fail preparation; discovery snapshots descriptions without body injection.
- [ ] Run `node --import tsx --test test/skill-testing/campaign-contracts.test.ts` and confirm the missing behavior fails.
- [ ] Implement strict contracts and immutable snapshot creation with content hashes. Reject output-root collisions rather than overwriting an experiment. Preserve raw historical formats through a separate legacy reader.
- [ ] Run the focused tests and existing `test/skill-scenario-harness.test.ts`; commit the independently working preparation seam.

## Task 2: Execute and resume trials through an explicit adapter

**Files:** Create `runner.ts`, `codex-adapter.ts`, `cli.ts`, `test/skill-testing/campaign-runner.test.ts`; update `package.json`.

**Interfaces:** Adapter exposes `execute({prompt, cwd, requestedSettings, timeoutMs, signal})` returning raw events, raw final output, observed metadata, and terminal status. Runner consumes the frozen manifest and journals attempts before dispatch and after output capture. CLI supports `prepare --config <file>`, `run --campaign <dir>`, `resume --campaign <dir>`, and `status --campaign <dir>`; live execution requires explicit `--backend codex`. Default test execution uses a fake adapter, never a live model.

- [ ] Test a two-trial campaign with a fake child adapter: success, timeout, interrupted execution, malformed final output, and a crash after capture. Resume reuses captured outputs and only retries unfinished/error attempts; the previous attempts remain inspectable. A behavioral rerun adds a repetition rather than replacing a failure.
- [ ] Run `node --import tsx --test test/skill-testing/campaign-runner.test.ts` for RED evidence.
- [ ] Implement bounded concurrency, stable IDs, atomic per-attempt capture, append-only journal records, and interrupted-state recovery. Invoke `codex exec` in fresh scratch directories through argument arrays and stdin; capture JSON events and final output. Check the installed CLI's `--json`, `--ephemeral`, output-schema and output-file support before using them; unsupported required flags fail preflight with the exact capability gap. No shell-built prompts or secrets in manifests. Record unavailable observed settings honestly and record ambient runtime configuration that affects comparisons.
- [ ] Run the focused tests, CLI preparation/status smoke checks, and commit. No live campaign is launched by `npm run verify`.

## Task 3: Grade observable behavior and calibrate semantic judgments

**Files:** Create `graders.ts`, `test/skill-testing/campaign-graders.test.ts`, and owning-skill calibration fixtures under `tests/behavior/calibration/`.

**Interfaces:** `gradeTrial(manifest, capturedOutput, graderConfig)` returns separate actor-contract, deterministic and semantic criterion records plus evaluator errors. `calibrate(rubric, labeledTraces)` reports per-criterion agreement and disputed cases. Adjudication is a separate record, never an edit to a raw grade.

- [ ] Test complete proposed requests against exported `runRequestSchema` and offline inspection fixtures; a wrong selection/history/material packet fails even when prose is plausible. An intentionally incomplete design reply is evaluated for needed clarification, not forcibly parsed as a complete run. Test unknown tool, stale scenario ID, invalid evaluator output, and an evaluator timeout separately.
- [ ] Add good, bad, and borderline calibration traces with explicit expected criterion labels and rationale. Include an invalid request dressed in correct terminology and an unsupported interpretation. Run focused tests for RED evidence.
- [ ] Implement deterministic graders using real source contracts and controlled store/inspection fixtures, with no provider calls. Render semantic evaluator prompts in separate contexts without arm labels or prior judgments; retain pass/fail/uncertain with cited evidence. Allow calibration disagreement to flag review instead of silently forcing a passing result.
- [ ] Run `node --import tsx --test test/skill-testing/campaign-graders.test.ts` and existing relevant inspection tests; commit.

## Task 4: Support discovery and scripted conversations

**Files:** Extend campaign contracts/runner; create `test/skill-testing/campaign-suites.test.ts`; add skill-owned discovery and workflow fixtures.

**Interfaces:** Discovery trials receive the two skill names/descriptions and request, return chosen skill or none plus rationale, and are reported as controlled discovery. Workflow trials contain ordered user/evidence turns and observable checkpoint criteria; the adapter preserves one actor session within a trial, starts a new session between trials, and reveals turns incrementally. Keep the backend conversation support explicit rather than presenting unrelated single-turn calls as a conversation.

For the Codex adapter, use `codex exec --json` to start workflow trials, capture the returned session ID, and `codex exec resume <session-id> --json` for subsequent turns after verifying the installed resume flags. Do not use `--ephemeral` for workflows that require resume. Focused/discovery trials can use ephemeral sessions. Persist the workflow session ID and last completed turn in the attempt record, and never use `--last`, which could attach to another trial. If session history cannot be recovered, retain the interrupted trial and restart as a linked new attempt rather than claiming continued context.

- [ ] Add positive and near-miss discovery cases for both skills, including requests sharing polling vocabulary but not needing a study. Add a design/cohort/approval/partial-result/changed-follow-up script with no paid Sheg execution.
- [ ] Test that discovery receives no skill body, actors receive no rubric or future turns, workflow context persists within a trial, and two trials share no conversation. Test a missing backend conversation capability as a preflight error.
- [x] Implement suite selection by owner, tags, and relevant guidance paths, with optional shared-safeguard inclusion. Preserve scenario coverage while keeping past campaign outputs in Git history only. Add a held-out wording variant for a material/history case without tuning guidance to its answer.
- [ ] Run `node --import tsx --test test/skill-testing/campaign-suites.test.ts`; commit.

## Task 5: Report comparisons and encode the operating posture

**Files:** Create `report.ts`, `test/skill-testing/campaign-report.test.ts`; modify `.agents/doctrine/skill-behavior-testing.md`, `AGENTS.md`, and skill-owned campaign fixture checks in `test/skill-scenario-harness.test.ts`.

**Interfaces:** CLI `grade`, `calibrate`, `compare`, and `report` consume retained campaign directories. Reports produce escaped static HTML, Markdown, and JSON showing per-scenario/criterion counts, sample size, complete-trial passes, uncertainty, failures, runtime errors, missing metadata, guidance hashes, measured timing/usage, and links to exact outputs. Qualitative A/B comparisons have reproducibly shuffled labels and swapped-order judgments; expose disagreements and human adjudication. No composite quality score or significance claim.

- [ ] Test changed-input rejection, order-swapped comparison disagreement, unavailable usage, failed attempts excluded from behavioral denominators but visibly counted, and HTML escaping of actor text.
- [x] Implement reports and generic evidence validators driven by campaign manifests, retaining external legacy trace compatibility where useful. Keep campaign results out of source. Replace bespoke current-campaign result expectations with reusable contract and scenario checks. Campaign comparisons report per-criterion pass/fail/uncertain counts and candidate-minus-baseline deltas.
- [ ] Write doctrine describing exactly what the runner enforces, what the operator decides, required calibration/review, suite selection, evidence retention, and limits. Route to it from the small AGENTS entrypoint. Keep tool isolation outside ownership.
- [ ] Run `node --import tsx --test test/skill-testing/campaign-report.test.ts test/skill-scenario-harness.test.ts test/release-package.test.ts`; commit.

## Task 6: Prove the experiment loop and publish the checkpoint

**Files:** Live campaign inputs in the owning skill, version manifests, generated runtime, roadmap, and the paused Plan 4 handoff. Campaign outputs remain transient and off-repository.

- [x] Close whole-branch review findings in workflow prompt construction, selected-material grading, grade recovery, frozen historical grading, comparison invariants, Codex capability preflight, and runtime identity. Deterministic tests cover actor/evaluator output separation during recovery, Choice/Score/Noul filters, exact source-run and evaluation/context resolution, inline selected-material validation, no-guidance workflow dispatch, and effective-concurrency identity.

- [x] Prepare a small live smoke campaign with explicit runtime/model settings under existing account-backed Codex access. No paid Sheg provider calls. Use frozen old/candidate guidance with a deliberate narrowly scoped test mutation, a no-guidance attribution arm, known calibration cases, discovery near-misses, and one scripted workflow. Keep the mutation only in a campaign snapshot.
- [x] Pressure-test workflow actors call the Sheg MCP tools required by their frozen checkpoints. Preserve raw CLI events and have the harness deterministically verify observed Sheg calls. Tool isolation and universal tool-use auditing remain ambient Agent Capability Pack concerns; do not add Sheg-owned hooks, telemetry, or isolation, and do not infer tool absence from actor claims.
- [x] Interrupt and resume one campaign; verify retained captured output is not redispatched, capture evaluator output separately, detect the controlled mutation through tool checkpoints, and inspect report drill-down. Repeat the workflow with held-out wording. If the installed backend cannot execute a required capability, report it and stop that dependent proof; do not label fake-adapter results as live evidence.
- [x] Inspect live manifests, raw outputs, grades, adjudications, and reports transiently outside the repository, then discard the campaign directories after review. Commit reusable skill tests and fixtures, never campaign results or receipts. Do not require the candidate to pass every capability case.
- [x] Align authoritative versions to `0.3.0-dev.5`, run `npm run build`, and `npm run plugin:package -- --validate-only`. Package a no-tag candidate ZIP in scratch and confirm skills ship while tests/campaign artifacts do not. Keep package inspection details in transient development output; do not commit receipts.
- [ ] Stage and commit through the tracked hook's `npm run verify`; obtain fresh whole-branch review, fix findings and rerun affected checks, then publish a PR targeting develop under the existing roadmap authorization. Update roadmap with verified head/check/merge evidence after each system proves it. No stable release/tag.
- [ ] After merge, resume Plan 4 by rebasing its retained branch onto the new develop and resolving shared docs/harness changes. Preserve completed Tasks 1-3, reassess generated contracts and focused product tests, replace preliminary Task 4 manual results with a frozen old/new campaign using this harness, and target `0.3.0-dev.6`. Update its JIT plan before executing resumed work.

## Completion evidence

Return the execution base/worktree, validation outcome, concise live-campaign conclusions while transient output is available, candidate package exclusion, PR/head/check state, and the updated Plan 4 resume handoff. Do not preserve campaign outputs, test-result summaries, package receipts, or other development receipts in the repository. Use Git history for implementation history. A deterministic green gate alone does not prove skill improvement.
