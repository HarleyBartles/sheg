# Sheg v0.3.0 dogfood improvement roadmap

Status: Plans 1 through 11 are merged to `develop`; their executable artifacts have been retired in successor slices. Native TypeSafe inference, realistic native author validation, self-contained marketplace packaging, and forward-compatible datastore upgrades remain v0.3.0 release requirements. The approved candidate is undergoing further source-quality work before stable promotion. No release tag or publication is authorized.

## Workspace and base

- Current SQLite quality slice: [dev.15 plan](../dev15-sqlite-quality.md), based on merged dev.14 commit `3e8876153d278241012e13f4301a7738ff03e837`.
- Implementation follows `.agents/runbooks/implementing.md`, `.agents/playbooks/gitflow-branch-and-release.md`, `.agents/playbooks/semver-version-alignment.md`, and `AGENTS.md`.

## Outcome

An author can ask an agent to stage a reading journey, select respondents' material and reuse it in isolation, explicitly resume eligible respondent-local failures without losing completed answers or reached paths, understand failures and stopped partial runs, and compare evidence without losing its framing. The installed package identifies its development version accurately. Versioned fresh-agent scenarios protect the skills that teach this workflow. Native TypeSafe inference works within an evidence-backed admission policy and supports a realistic author study and follow-up before v0.3.0 release. Datastore upgrades after v0.3.0 preserve user data through tested migrations and retain a usable recovery surface if migration cannot complete.

## Study-input variation principle

Rich results come from deliberate variation in the study inputs: respondent profile, stimulus, question/response, and state such as prior-turn visibility. Treat inputs matching across all four dimensions as duplicates for study-design purposes; rerunning them can sample ordinary model variability, but does not add substantive coverage. Do not advise agents to repeat the same input in search of a different result or to choose the smallest cohort by default. The cohort supplies respondent-profile variation, so size and compose it for the differences the author needs to understand.

Plans 5 and 10 delivered this principle. Plan 5 makes represented respondents and selected inputs legible without equating call counts with input diversity. Plan 10 teaches purposeful variation across all four dimensions and pressure-tests duplicate-input recognition against useful changes. Add duplicate detection to runtime only if implementation evidence shows the contract needs it.

## Remaining implementation plans

Each next executable plan is written against the delivered code of its predecessor. Each gets a fresh canonical worktree and its own PR into `develop`. Every develop merge increments the development prerelease number; write the target version into the plan before execution. Do not merge planning artifacts alone under the old version. Write each detailed plan just in time; roadmap acceptance records are not substitutes for runnable plans.

| # | Title | Status | Plan file | Target version |
| --- | --- | --- | --- | --- |
| 5 | Expose precise failure and lifecycle evidence | merged to `develop` in PR #17 | Retired after merge | `0.3.0-dev.7` |
| 6 | Enable native TypeSafe inference and verify a realistic author journey | merged to `develop` in PR #18 | Retired after merge | `0.3.0-dev.8` |
| 7 | Resume eligible respondent-local failures in partial journeys | merged to `develop` in PR #19 | Retired after merge | `0.3.0-dev.9` |
| 8 | Ship one reproducible self-contained plugin package across Git and ZIP | merged to `develop` in PR #20 | Retired after merge | `0.3.0-dev.10` |
| 9 | Establish datastore upgrade compatibility from the 0.3.0 baseline | merged to `develop` in PR #21 | Retired in this successor slice | `0.3.0-dev.11` |
| 10 | Reconcile guidance and verify the installed author journey | merged to `develop` in PR #22 | Retired in this successor slice | `0.3.0-dev.12` |
| 11 | Count selected journey material in matched query coverage | merged to `develop` in PR #23 | Retired in this successor slice | `0.3.0-dev.13` |

## Plan 11: journey selected-material summary

Normalize grouped-poll bare typed answers and full journey `DecisionResult` answers before matched-coverage counting so mapped journey Choice selections contribute to aggregate material counts. Preserve stored data and row-level source custody; exclude no-fit/unmapped Choices; keep summary values stable across pagination.

## Validation and handoff

Each executable plan specifies files, behavioral proof, and commands. Regenerate canonical contracts/runtime before committing changes that affect them. Let the tracked pre-commit hook run `npm run verify` against the staged snapshot; never bypass it. Do not immediately repeat the same full gate without a new change or unresolved concern. Focused tests and build evidence supplement that gate. Skill behavior campaigns run only when explicitly invoked, stay outside CI and pre-commit, and their outputs are inspected during development then discarded; source-owned scenarios and calibration fixtures remain with the skills, and deterministic harness tests remain under `test/`.

Execution is sequential through `executing-plans`: context, follow-on and lifecycle contracts share persisted packets, compiler identity, generated contracts and agent guidance. Scenario actors are fresh by design; that is a test requirement, not permission to delegate implementation.

The continuing objective authorizes implementation, a PR into `develop`, and a merge after fresh review and required checks pass. It does not authorize a stable release tag or GitHub Release. The user separately authorized paid native TypeSafe validation for an initial budget of 500 API calls; seek authorization before exceeding it. Git history records completed development work. No paid call budget transfers from the Portfolio pilot.
