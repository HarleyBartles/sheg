# Sheg v0.3.0 dogfood improvement roadmap

Status: Plan 1 merged; Plan 2 implementation and baseline campaign are complete, with validation and review handoff in progress. Authority: [agreed scope](../../specs/2026-10-02-v0.3.0-dogfood-improvements.md). Plan 1 delivered `0.3.0-dev.2`; Plan 2 targets `0.3.0-dev.3`. No release tag or publication is authorized.

## Workspace and base

- Current worktree: `Z:/_agent-worktrees/sheg/codex/v0.3.0-skill-scenarios`.
- Current branch: `codex/v0.3.0-skill-scenarios`, based on `origin/develop` at Plan 1 merge `7e2943bf1daec403ae5e56e7166eb68f9d868474`.
- Plan 2 initial linked-worktree status: clean. Baseline `npm test`: 327 tests passed, zero failed, zero skipped.
- Plan 1 merged as PR #12 at `7e2943bf1daec403ae5e56e7166eb68f9d868474`; its prior linked worktree and local branch were removed after exact PR/head/develop verification.
- Shared root exception: `Z:/sheg` is configured `core.bare=true`, with an existing staged snapshot. Its main ref equals fetched `origin/main` at `9bc6a961313ce38e3614dc238a708599e7637d50`. The bundled worktree script created the canonical worktree without changing that configuration or staged snapshot. Fresh develop was fetched explicitly because the remote fetch configuration only tracks main by default.
- Planning and implementation guidance: `.agents/runbooks/implementing.md`, `.agents/playbooks/gitflow-branch-and-release.md`, `.agents/playbooks/semver-version-alignment.md`, and `AGENTS.md`.

## Outcome

An author can ask an agent to stage a reading journey, select respondents' material and reuse it in isolation, understand failures and stopped partial runs, and compare evidence without losing its framing. The installed package identifies its development version accurately. Versioned fresh-agent scenarios protect the skills that teach this workflow.

## Consecutive implementation plans

Write each next executable plan against the delivered code of its predecessor. Later rows define committed scope and acceptance, not imaginary completed plans. Each JIT plan gets a fresh canonical worktree and its own PR into develop. Every develop merge increments the development prerelease number: Plan 1 merges `0.3.0-dev.2`; Plans 2-6 merge `0.3.0-dev.3` through `0.3.0-dev.7`, respectively. Write the target version into each plan before executing it. Do not merge the planning artifacts alone under the old version.

| # | Title | Status | Plan file | Commit | PR | Rating | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Align development identity and candidate packaging | merged | [Plan 1](01-development-version-and-packaging.md) | `7e2943bf1dae` | [#12](https://github.com/HarleyBartles/sheg/pull/12) | - | Merged to `develop` as `0.3.0-dev.2`. Candidate ZIP identity and stable publication protections verified |
| 2 | Establish skill behavior scenarios and baseline | validation/review | [Plan 2](02-skill-behavior-scenarios.md) | - | - | - | Target `0.3.0-dev.3`. Six skill-owned scenarios, private evaluator boundary, fresh-agent baseline and matched controls recorded; `npm run verify` passes |
| 3 | Unify journey context across sequence and graph | pending | Not authored yet | - | - | - | Merge version `0.3.0-dev.4`. One graph execution model, cumulative exposed material, separate answer-history choice, identical preview/fit/runtime packets and protected frozen evidence |
| 4 | Follow each selected stimulus in one run | pending | Not authored yet | - | - | - | Merge version `0.3.0-dev.5`. Per-source-answer material mapping, optional shared stimulus, no-fit coverage, exact provenance, race protection and deletion-independent recall |
| 5 | Expose precise failure and lifecycle evidence | pending | Not authored yet | - | - | - | Merge version `0.3.0-dev.6`. Safe structured validation reasons, consistent execution/coverage/recovery, selected-question coverage and captured query-state semantics |
| 6 | Reconcile guidance and verify the installed author journey | pending | Not authored yet | - | - | - | Merge version `0.3.0-dev.7`. Comparative interpretation guidance, old/new scenario evidence, copied candidate integration, final source/generated agreement |

## Plan exits and likely source seams

### 1. Version and packaging

Own `package.json`, `package-lock.json`, `plugin.json`, runtime product identity, `scripts/package-plugin.py`, release/package tests, version playbooks and release guide. Add a version-policy ADR that partially supersedes ADR-0013. Local ZIP verification must distinguish candidate packaging from stable tag publication.

### 2. Skill scenarios

Own `skills/study-design/tests/behavior/`, `skills/stimulus-response-polling/tests/behavior/` and a small shared fixture/evaluator seam if duplication actually requires it. Deterministic harness checks belong to the normal gate; live agent trials are an explicit campaign with retained traces. Establish current-guidance success and failure evidence before later edits. Run no paid Sheg calls. Do not treat one agent's compliance or a canned trace as a completed pressure campaign.

### 3. Journey context

Own `src/domain/study/presentation.ts`, `src/domain/decision/prompt.ts`, `src/domain/journey/`, the durable journey admission/worker seams and their behavior tests. Define material order, repeated exposure and history semantics before implementation; preserve separate answer-history controls. Update compiler identity and generated schemas, then skills and scenario fixtures in the same slice. Do not silently reinterpret already accepted runs.

### 4. Selected-stimulus reuse

Own `src/domain/run/request.ts`, `src/application/run-inspection.ts`, source resolution in `src/infrastructure/run-store.ts`, generated request contracts and copied-package follow-on tests. The owning plan specifies one explicit per-selection material resolver and its compatible interaction with current `recorded`, `continue`, `fresh-material` and `omit-history` modes. Preserve strict request validation. Demonstrate the pull quote plus three selecting respondents and one no-fit respondent in one follow-on run.

### 5. Failures and lifecycle

Own typed decision validation, provider/worker failure propagation, `src/domain/run/lifecycle.ts`, lifecycle projection in the service/store, query coverage/lineage, MCP descriptions and generated contracts. Keep this slice focused on evidence semantics; do not redesign worker scheduling. One projection must agree with actual resume eligibility. Prove partial stopped status with successful selected answers, safe detailed invalid-answer evidence, and uncertain-attempt allowance behavior.

### 6. Combined guidance and installed proof

Own comparison/interpretation references and package integration scenarios. Earlier slices already ship guidance for their contracts. This final slice checks the conversation as a whole: staged reading, material selection, isolated reuse, changed framing, one invalid answer, successful explicit retry and later recall. Read current skills as an agent receives them; run the versioned fresh-context scenarios with fixed criteria and retained traces. Report both strengths preserved and remaining limitations.

## Validation and handoff

Each executable plan supplies exact files, behavioral proof and commands. Regenerate canonical contracts/runtime before committing changes that affect them. Let the tracked pre-commit hook run `npm run verify` against the staged snapshot; never bypass it. Do not immediately repeat the same full gate without a new change or unresolved concern. Focused tests and build evidence supplement that gate.

Execution is sequential through `executing-plans`: the context, follow-on and lifecycle contracts share persisted packets, compiler identity, generated contracts and agent guidance. Fresh implementers per small seam would repeatedly reconstruct that shared state. Scenario actors are fresh by design; that is a test requirement, not permission to delegate implementation.

The initial planning turn ended before implementation. This continuing objective authorizes implementation, a PR into develop and a merge after fresh review and required checks pass. It does not authorize a stable release tag, GitHub Release or paid inference. Final roadmap handoff records version alignment, copied-package proof, tests, skill campaign evidence, exact head and outstanding provider/human-reader limitations. No paid call budget transfers from the Portfolio pilot.
