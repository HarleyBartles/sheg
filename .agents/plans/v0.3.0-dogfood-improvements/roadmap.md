# Sheg v0.3.0 dogfood improvement roadmap

Status: Plans 1, 2, 3, and 3a are merged; Plan 4 is active. The next development candidate is `0.3.0-dev.6`. No release tag or publication is authorized.

## Workspace and base

- Feature worktree: `Z:/_agent-worktrees/sheg/codex/v0.3.0-selected-stimulus`, branch `codex/v0.3.0-selected-stimulus`.
- Implementation follows `.agents/runbooks/implementing.md`, `.agents/playbooks/gitflow-branch-and-release.md`, `.agents/playbooks/semver-version-alignment.md`, and `AGENTS.md`.

## Outcome

An author can ask an agent to stage a reading journey, select respondents' material and reuse it in isolation, understand failures and stopped partial runs, and compare evidence without losing its framing. The installed package identifies its development version accurately. Versioned fresh-agent scenarios protect the skills that teach this workflow.

## Study-input variation principle

Rich results come from deliberate variation in the study inputs: respondent profile, stimulus, question/response, and state such as prior-turn visibility. Treat inputs matching across all four dimensions as duplicates for study-design purposes; rerunning them can sample ordinary model variability, but does not add substantive coverage. Do not advise agents to repeat the same input in search of a different result or to choose the smallest cohort by default. The cohort supplies respondent-profile variation, so size and compose it for the differences the author needs to understand.

Carry this principle through Plans 4-6. Plan 4 should explain that each respondent's selected material supplies stimulus variation for the isolated follow-up while keeping its shared framing and question interpretable. Plan 5 should preserve enough coverage and lifecycle evidence to explain which respondents and selected inputs were represented, without treating call counts as input diversity. Plan 6 should teach agents to choose purposeful variation across the four dimensions and pressure-test duplicate-input recognition against useful changes. Add duplicate detection to runtime only if implementation evidence shows the contract needs it.

## Consecutive implementation plans

Write each next executable plan against the delivered code of its predecessor. Later rows define committed scope and acceptance, not imaginary completed plans. Each JIT plan gets a fresh canonical worktree and its own PR into develop. Every develop merge increments the development prerelease number: Plans 1-3 delivered `0.3.0-dev.2` through `0.3.0-dev.4`; Plan 3a targets `0.3.0-dev.5`, followed by Plans 4-6 targeting `0.3.0-dev.6` through `0.3.0-dev.8`. Write the target version into each plan before executing it. Do not merge the planning artifacts alone under the old version.

| # | Title | Status | Plan file | Commit | PR | Rating | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Align development identity and candidate packaging | merged | [Plan 1](01-development-version-and-packaging.md) | - | - | - | `0.3.0-dev.2` |
| 2 | Establish skill behavior scenarios and baseline | merged | [Plan 2](02-skill-behavior-scenarios.md) | - | - | - | `0.3.0-dev.3` |
| 3 | Unify journey context across sequence and graph | merged | [Plan 3](03-journey-context.md) | - | - | - | `0.3.0-dev.4` |
| 3a | Build the repeatable skill campaign harness | merged | [Plan 3a](03a-skill-campaign-harness.md) | - | - | - | `0.3.0-dev.5`; campaign outputs stay transient, behavior campaigns stay outside CI and pre-commit |
| 4 | Follow each selected stimulus in one run | active | [Plan 4](04-selected-stimulus-reuse.md) | - | - | - | `0.3.0-dev.6`; reuse each selected piece as that respondent's follow-up stimulus, with shared framing, exclusions, provenance, race protection, and deletion-independent recall |
| 5 | Expose precise failure and lifecycle evidence | pending | Not authored yet | - | - | - | Merge version `0.3.0-dev.7`. Safe structured validation reasons, consistent execution/coverage/recovery, selected-question coverage and captured query-state semantics; make represented respondents and selected inputs legible without equating call counts with input diversity |
| 6 | Reconcile guidance and verify the installed author journey | pending | Not authored yet | - | - | - | Merge version `0.3.0-dev.8`. Comparative interpretation guidance, old/new scenario evidence, purposeful variation across the four input dimensions, duplicate-input recognition, copied candidate integration, final source/generated agreement |

## Plan exits and likely source seams

### 1. Version and packaging

Own `package.json`, `package-lock.json`, `plugin.json`, runtime product identity, `scripts/package-plugin.py`, release/package tests, version playbooks and release guide. Add a version-policy ADR that partially supersedes ADR-0013. Local ZIP verification must distinguish candidate packaging from stable tag publication.

### 2. Skill scenarios

Own skill guidance and its behavior tests under each skill's `tests/` directory. Deterministic harness checks belong to the normal gate; live agent campaigns are explicit, run outside CI and pre-commit, and their outputs remain transient. Establish current-guidance behavior before later edits. Do not treat one agent's compliance or a canned trace as a completed pressure campaign.

### 3. Journey context

Own `src/domain/study/presentation.ts`, `src/domain/decision/prompt.ts`, `src/domain/journey/`, the durable journey admission/worker seams and their behavior tests. Define material order, repeated exposure and history semantics before implementation; preserve separate answer-history controls. Update compiler identity and generated schemas, then skills and scenario fixtures in the same slice. Do not silently reinterpret already accepted runs.

### 3a. Repeatable skill campaigns

Own `scripts/skill-testing/`, shared deterministic harness tests, skill-owned discovery/workflow/calibration fixtures, and skill-testing doctrine. The harness compares frozen old/new guidance with separate attribution controls, distinguishes runtime errors from behavior failures, and checks executable requests against controlled evidence. Live campaigns run explicitly outside CI and pre-commit; inspect their outputs during development, then discard them. Tool isolation is an ambient Agent Capability Pack concern and is outside this slice.

### 4. Selected-stimulus reuse

Own `src/domain/run/request.ts`, `src/application/run-inspection.ts`, source resolution in `src/infrastructure/run-store.ts`, generated request contracts and copied-package follow-on tests. The owning plan specifies one explicit per-selection material resolver and its compatible interaction with current `recorded`, `continue`, `fresh-material` and `omit-history` modes. Preserve strict request validation. Demonstrate the pull quote plus three selecting respondents and one no-fit respondent in one follow-on run.

### 5. Failures and lifecycle

Own typed decision validation, provider/worker failure propagation, `src/domain/run/lifecycle.ts`, lifecycle projection in the service/store, query coverage/lineage, MCP descriptions and generated contracts. Keep this slice focused on evidence semantics; do not redesign worker scheduling. One projection must agree with actual resume eligibility. Prove partial stopped status with successful selected answers, safe detailed invalid-answer evidence, and uncertain-attempt allowance behavior.

### 6. Combined guidance and installed proof

Own comparison/interpretation references and package integration scenarios. Earlier slices already ship guidance for their contracts. This final slice checks the conversation as a whole: staged reading, material selection, isolated reuse, changed framing, one invalid answer, successful explicit retry and later recall. Read current skills as an agent receives them; run versioned fresh-context scenarios with fixed criteria and transient campaign outputs. Include cases where an identical input is repeated and where one input dimension changes purposefully. Report both strengths preserved and remaining limitations.

## Validation and handoff

Each executable plan supplies exact files, behavioral proof and commands. Regenerate canonical contracts/runtime before committing changes that affect them. Let the tracked pre-commit hook run `npm run verify` against the staged snapshot; never bypass it. Do not immediately repeat the same full gate without a new change or unresolved concern. Focused tests and build evidence supplement that gate.

Execution is sequential through `executing-plans`: the context, follow-on and lifecycle contracts share persisted packets, compiler identity, generated contracts and agent guidance. Fresh implementers per small seam would repeatedly reconstruct that shared state. Scenario actors are fresh by design; that is a test requirement, not permission to delegate implementation.

The initial planning turn ended before implementation. This continuing objective authorizes implementation, a PR into develop and a merge after fresh review and required checks pass. It does not authorize a stable release tag, GitHub Release or paid inference. Keep the status and next development version current; Git history records completed development work. No paid call budget transfers from the Portfolio pilot.
