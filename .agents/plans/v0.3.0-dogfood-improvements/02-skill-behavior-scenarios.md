# Skill Behavior Scenarios and Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task.

**Goal:** Version six focused, skill-owned behavior scenarios and establish a repeatable way to inspect current Sheg guidance without calling Sheg inference or editing skill guidance.

**Architecture:** Store scenario inputs and evaluator criteria in separate files beneath the owning skills. A small prompt renderer supplies the actual current skill and selected references to a fresh actor, while a separate evaluator renderer can include the private criteria and observed trace; deterministic tests validate that boundary and the scenario fixtures. Exclude skill test assets from the shipped plugin, and advance all product identity surfaces to `0.3.0-dev.3` for this planned develop checkpoint.

**Tech Stack:** Node.js 24, TypeScript/tsx, Node test runner, JSON scenario fixtures, fresh Codex subagents for actor and evaluator trials, Python packaging helper.

**Spec:** [Agreed dogfood improvement scope](../../specs/2026-10-02-v0.3.0-dogfood-improvements.md), sections 4 and 6. [Parent roadmap](roadmap.md). Read both before execution.

**Execution Strategy:** `executing-plans`, sequentially. Scenario fixtures, prompt isolation, actor traces and evaluator criteria form one evidence contract; the packaging exclusion and version bump are necessary to ship only the skill while preserving the target dev.3 merge identity.

## Global constraints

- Use this fresh canonical worktree `Z:/_agent-worktrees/sheg/codex/v0.3.0-skill-scenarios`, created from the merged `origin/develop` commit `7e2943bf1daec403ae5e56e7166eb68f9d868474`.
- The next develop-bound checkpoint advertises exactly `0.3.0-dev.3` in `package.json`, both root `package-lock.json` version fields, `plugin.json`, and the bundled MCP initialization response. Do not tag or publish it.
- Keep the package private and npm publication disabled. Stable release tags continue to require stable matching manifests.
- Do not edit either shipped `SKILL.md` or its references in this plan. The purpose is to establish a baseline before guidance changes.
- Use synthetic article fragments and controlled Sheg result fixtures. Do not read or modify Portfolio articles, study databases, credentials, or retained pilot records.
- Actor prompts must include the actual current skill and only its relevant linked references. Keep evaluator criteria out of actor context. Evaluators judge observable choices and claims, not phrase matching or self-reported compliance.
- Scenario actors produce proposed tool actions against mock fixtures only. They must not call Sheg, other connectors, or external services. No inference, messaging, or real study mutation is authorized.
- A baseline is evidence about these scenario inputs and this recorded model configuration, not proof of universal agent behavior. If a guided trial fails, run a matched no-guidance control before attributing the failure to the skill. Any later behavior-shaping wording change requires at least five fresh-context trials and manual inspection of each flagged result.
- Keep deterministic fixture/evaluator checks in `npm run verify`; keep fresh-agent scenario campaigns explicit and never trigger them in CI.
- No arbitrary Markdown wrapping, emoji, em-dashes, wording change-detector tests, or tautological tests.

## Review focus

- Actor prompt rendering must not expose evaluator criteria, expected outcomes, or a private rubric; Task 2 tests the observable prompt boundary.
- Skill test files must not enter the customer ZIP while normal skill guidance remains included; Task 1 packages an isolated fixture containing a private test sentinel.
- Scenarios that touch not-yet-shipped journey, selected-material, or lifecycle contracts must score honesty about current limits rather than assume future functionality; the relevant evaluator cases state those boundaries.
- A mock result is not evidence that a live Sheg tool ran; trace format and campaign report label simulated tool actions and controlled results explicitly.
- The baseline must preserve the existing careful comparison interpretation behavior as a positive case; one changed-rubric scenario checks claims against the supplied question and rubric.

## Task 1: Advance the checkpoint and keep skill tests out of packages

**Files:**
- Modify: `package.json`, `package-lock.json`, `plugin.json`.
- Modify: `scripts/package-plugin.py`.
- Modify: `test/release-package.test.ts`.
- Modify: `dist/mcp.js` only through `npm run build`.

**Interfaces:**
- Consumes: Plan 1's package-derived MCP identity and stable-only release-tag validation.
- Produces: a `0.3.0-dev.3` plugin identity and a package file walk that omits skill-local `tests/` paths while retaining skill runtime files.

- [x] Add a stable-package fixture test that creates `skills/study-design/tests/behavior/private-evaluator.json`, packages with `--tag v0.3.0`, and asserts the sentinel is absent while `skills/study-design/SKILL.md` remains present. Run `node --import tsx --test test/release-package.test.ts`; confirm the new test fails because the current package includes the sentinel.
- [x] Update the package walk to skip skill-local test trees without changing safe-path and symlink checks. Re-run `node --import tsx --test test/release-package.test.ts` and confirm the fixture archive retains normal skill files and excludes the sentinel.
- [x] Align the package version, both lockfile root versions, and plugin version to `0.3.0-dev.3`, preserving dependencies and `private: true`. Run `npm run build`, `npm run typecheck`, `node --import tsx --test test/mcp.test.ts`, and the copied-package suite `node --import tsx --test test/build.test.ts test/package.test.ts test/release-package.test.ts`.
- [x] Run `npm run plugin:package -- --validate-only`; create a local dev.3 ZIP under `Z:/_agent-scratch/sheg/codex-v0.3.0-skill-scenarios/`; inspect its manifest identity and confirm no skill test files are present. Confirm `npm run plugin:package -- --tag v0.3.0 --validate-only` rejects the candidate manifests.

## Task 2: Add separated skill behavior scenarios and prompt tooling

**Files:**
- Create: `skills/study-design/tests/behavior/scenarios.json` and `evaluators.json`.
- Create: `skills/stimulus-response-polling/tests/behavior/scenarios.json` and `evaluators.json`.
- Create: `skills/study-design/tests/behavior/README.md` with the campaign protocol.
- Create: `scripts/skill-scenario.ts` with list, guided actor, no-guidance control, and evaluator prompt rendering.
- Create: `test/skill-scenario-harness.test.ts`.
- Modify: `package.json` only to expose `npm run skill:scenario -- ...`.

**Interfaces:**
- Scenario records contain `id`, `version`, `ownerSkill`, `referencePaths`, `userRequest`, and `controlledEvidence`. Evaluator records separately contain the same `scenarioId` and `version`, `criteria` with unique IDs and observable conditions, and `prohibitedClaims`.
- `renderActorPrompt(scenarioId)` embeds the current owner `SKILL.md`, only the declared references, the realistic user request, controlled fixture evidence, and an output contract. It does not read or print evaluator files.
- `renderControlPrompt(scenarioId)` provides the same versioned request and evidence without skill guidance and returns a prompt SHA-256 for the recorded control input.
- Actor output is JSON with `scenarioId`, `scenarioVersion`, `actions` (proposed tool/input pairs, never executed), `finalResponse`, and `uncertainties`.
- `renderEvaluatorPrompt(scenarioId, actorTrace)` loads the separate evaluator criteria and controlled evidence with the captured actor output. Evaluator output is JSON with `scenarioId`, `criterionResults` (`criterionId`, `result: pass|fail|uncertain`, and evidence), and `notes`. It requests evidence-cited judgments, not phrase matching.
- Fresh actor execution remains a manual campaign using the generated prompt and Codex's fresh-context subagent route. The script never invokes a model or live tool. Evaluator replay rejects wrapped traces whose scenario identity or version differs from the selected rubric.

- [x] Write harness tests first for unique scenario IDs, valid owner/reference paths, exact evaluator-to-scenario pairing, and prompts that include only the intended private/public material. Run `node --import tsx --test test/skill-scenario-harness.test.ts` and capture the expected missing-renderer failure.
- [x] Implement the minimal fixture loader and prompt renderers with path containment, strict JSON shape checks, and clear errors for unknown IDs or missing references. Re-run the focused harness tests and confirm actor rendering cannot include evaluator criteria while evaluator rendering can include them.
- [x] Add six scenarios with stable IDs: `sequence-versus-linear-graph` for staged/interleaved exposure and context expectations; `independent-dependent-questions`; `selected-material-isolation-no-fit`; `partial-run-selected-question`; `typed-answer-failure`; and `changed-rubric-comparison`.
- [x] For current-baseline scoring, require truthful limits where the runtime does not yet support the future journey, per-selection mapping, or lifecycle contract. Define the comparison case as a positive preservation criterion: separate the changed task meaning from comparable evidence and do not claim causal improvement.
- [x] Add deterministic test assertions over the six fixtures, evaluator separation, mock-only execution contract, version-safe replay, exact control prompt digests, and trace metadata schema. Run `npm run skill:scenario -- --list` and `node --import tsx --test test/skill-scenario-harness.test.ts test/release-package.test.ts`.

## Task 3: Run and inspect the current-guidance baseline

**Files:** No actor, evaluator, campaign, or report outputs are committed. Keep only reusable scenario/evaluator source and deterministic harness tests.

**Interfaces:**
- Campaign outputs are temporary development artifacts. Inspect them during the run, then discard them; Git history records implementation changes.
- Treat actor and evaluator disagreement as a test-quality signal. Keep each trial distinct, inspect failures and uncertainty, and improve unstable scenarios or criteria rather than replacing failed outputs or relying on a single pass.

- [x] Render each actor prompt from the committed fixture and dispatch one fresh-context actor per scenario using `gpt-6-sol` at medium reasoning. Provide no evaluator criteria. Require the actor to return the structured trace contract and instruct against real tool calls; record that enforcement and auditing were unavailable.
- [x] For any guided scenario that fails or makes an unsupported product claim, render a version-bound no-guidance prompt with the same user request and controlled facts and compare the distinct fresh-context outputs before assigning a guidance-specific cause.
- [x] Evaluate each output separately with only that case's criteria, controlled fixture, and actor trace. Manually inspect every failed, disputed, or flagged judgment while the campaign is available, then discard campaign outputs.
- [x] Keep the six scenario inputs and evaluator criteria under their owning skill tests. Do not commit actor traces, results, campaign reports, package receipts, or other proof that development work happened.
- [x] Inspect interpretation behavior without converting one actor's response into a permanent skill test result. Do not broaden an evidence limitation into a rewrite of all guidance.

## Task 4: Complete, validate, and hand off Plan 2

**Files:**
- Modify: this plan and `roadmap.md` only when current scope or next-step status changes.

- [ ] Run `git diff --check`, inspect the complete diff, and confirm no skill guidance, Portfolio content, external provider setting, or live study data changed.
- [ ] Commit source, tests, and fixtures explicitly. The tracked `.githooks/pre-commit` must pass staged `npm run verify` with scenario fixture and package exclusion tests.
- [ ] Prepare the whole-branch review package against `7e2943bf1daec403ae5e56e7166eb68f9d868474`; complete a fresh clean review before PR creation. Create this plan's PR into `develop`; after exact-head CI passes, merge it as `0.3.0-dev.3` using a guarded merge.
- [ ] After the authorized merge, clean this plan's worktree and local branch using the bundled retirement helper.

## Delivered scope

The plan established versioned scenario inputs, separate private evaluators, deterministic prompt and fixture checks, and package exclusion for skill tests. Scenario tests are source; live actor and evaluator outputs are transient and are discarded after inspection. Follow the current posture in [skill behavior testing](../../doctrine/skill-behavior-testing.md). Git history records the implementation changes.
