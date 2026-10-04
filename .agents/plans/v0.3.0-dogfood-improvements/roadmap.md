# Sheg v0.3.0 dogfood improvement roadmap

Status: Plans 1, 2, 3, 3a, and 4 are merged to `develop`; Plans 5 and 6 remain. No release tag or publication is authorized.

## Workspace and base

- Current feature worktree: `Z:/_agent-worktrees/sheg/codex/v0.3.0-failure-lifecycle`, branch `codex/v0.3.0-failure-lifecycle`, based on the latest `develop` after Plan 4 merged.
- Implementation follows `.agents/runbooks/implementing.md`, `.agents/playbooks/gitflow-branch-and-release.md`, `.agents/playbooks/semver-version-alignment.md`, and `AGENTS.md`.

## Outcome

An author can ask an agent to stage a reading journey, select respondents' material and reuse it in isolation, understand failures and stopped partial runs, and compare evidence without losing its framing. The installed package identifies its development version accurately. Versioned fresh-agent scenarios protect the skills that teach this workflow.

## Study-input variation principle

Rich results come from deliberate variation in the study inputs: respondent profile, stimulus, question/response, and state such as prior-turn visibility. Treat inputs matching across all four dimensions as duplicates for study-design purposes; rerunning them can sample ordinary model variability, but does not add substantive coverage. Do not advise agents to repeat the same input in search of a different result or to choose the smallest cohort by default. The cohort supplies respondent-profile variation, so size and compose it for the differences the author needs to understand.

Carry this principle through Plans 5 and 6. Plan 5 makes represented respondents and selected inputs legible without equating call counts with input diversity. Plan 6 teaches purposeful variation across all four dimensions and pressure-tests duplicate-input recognition against useful changes. Add duplicate detection to runtime only if implementation evidence shows the contract needs it.

## Remaining implementation plans

Each next executable plan is written against the delivered code of its predecessor. Each gets a fresh canonical worktree and its own PR into `develop`. Every develop merge increments the development prerelease number; write the target version into the plan before execution. Do not merge planning artifacts alone under the old version.

| # | Title | Status | Plan file | Target version |
| --- | --- | --- | --- | --- |
| 5 | Expose precise failure and lifecycle evidence | active | [Plan 5](05-failure-lifecycle-evidence.md) | `0.3.0-dev.7` |
| 6 | Reconcile guidance and verify the installed author journey | pending | Not authored yet | `0.3.0-dev.8` |

## Plan 5: failures and lifecycle

Own typed decision validation, provider/worker failure propagation, `src/domain/run/lifecycle.ts`, lifecycle projection in the service/store, query coverage/lineage, MCP descriptions and generated contracts. Keep this slice focused on evidence semantics; do not redesign worker scheduling. One projection must agree with actual resume eligibility. Prove partial stopped status with successful selected answers, safe detailed invalid-answer evidence, and uncertain-attempt allowance behavior.

## Plan 6: combined guidance and installed proof

Own comparison/interpretation references and package integration scenarios. Earlier slices already ship guidance for their contracts. This final slice checks the conversation as a whole: staged reading, material selection, isolated reuse, changed framing, one invalid answer, successful explicit retry and later recall. Read current skills as an agent receives them; run versioned fresh-context scenarios with fixed criteria and transient campaign outputs. Include cases where an identical input is repeated and where one input dimension changes purposefully. Report strengths preserved and remaining limitations.

## Validation and handoff

Each executable plan specifies files, behavioral proof, and commands. Regenerate canonical contracts/runtime before committing changes that affect them. Let the tracked pre-commit hook run `npm run verify` against the staged snapshot; never bypass it. Do not immediately repeat the same full gate without a new change or unresolved concern. Focused tests and build evidence supplement that gate. Skill behavior campaigns run only when explicitly invoked, stay outside CI and pre-commit, and their outputs are inspected during development then discarded; source-owned scenarios and calibration fixtures remain with the skills, and deterministic harness tests remain under `test/`.

Execution is sequential through `executing-plans`: context, follow-on and lifecycle contracts share persisted packets, compiler identity, generated contracts and agent guidance. Scenario actors are fresh by design; that is a test requirement, not permission to delegate implementation.

The continuing objective authorizes implementation, a PR into `develop`, and a merge after fresh review and required checks pass. It does not authorize a stable release tag, GitHub Release or paid inference. Git history records completed development work. No paid call budget transfers from the Portfolio pilot.
