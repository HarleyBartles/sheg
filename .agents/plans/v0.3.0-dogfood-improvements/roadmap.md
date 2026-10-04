# Sheg v0.3.0 dogfood improvement roadmap

Status: Plans 1 through 7 are merged to `develop`; Plans 8, 9, and 10 remain. Native TypeSafe inference, realistic native author validation, self-contained marketplace packaging, and forward-compatible datastore upgrades are required for the v0.3.0 launch. No release tag or publication is authorized.

## Workspace and base

- Current planning worktree: `Z:/_agent-worktrees/sheg/codex/v0.3.0-marketplace-package`, branch `codex/v0.3.0-marketplace-package`, based on Plan 7 merge `8f2ad5fd133367a872c99cf46ec92b7c7eea5327`.
- Implementation follows `.agents/runbooks/implementing.md`, `.agents/playbooks/gitflow-branch-and-release.md`, `.agents/playbooks/semver-version-alignment.md`, and `AGENTS.md`.

## Outcome

An author can ask an agent to stage a reading journey, select respondents' material and reuse it in isolation, explicitly resume eligible respondent-local failures without losing completed answers or reached paths, understand failures and stopped partial runs, and compare evidence without losing its framing. The installed package identifies its development version accurately. Versioned fresh-agent scenarios protect the skills that teach this workflow. Native TypeSafe inference works within an evidence-backed admission policy and supports a realistic author study and follow-up before v0.3.0 release. Datastore upgrades after v0.3.0 preserve user data through tested migrations and retain a usable recovery surface if migration cannot complete.

## Study-input variation principle

Rich results come from deliberate variation in the study inputs: respondent profile, stimulus, question/response, and state such as prior-turn visibility. Treat inputs matching across all four dimensions as duplicates for study-design purposes; rerunning them can sample ordinary model variability, but does not add substantive coverage. Do not advise agents to repeat the same input in search of a different result or to choose the smallest cohort by default. The cohort supplies respondent-profile variation, so size and compose it for the differences the author needs to understand.

Carry this principle through Plans 5 and 10. Plan 5 makes represented respondents and selected inputs legible without equating call counts with input diversity. Plan 10 teaches purposeful variation across all four dimensions and pressure-tests duplicate-input recognition against useful changes. Add duplicate detection to runtime only if implementation evidence shows the contract needs it.

## Remaining implementation plans

Each next executable plan is written against the delivered code of its predecessor. Each gets a fresh canonical worktree and its own PR into `develop`. Every develop merge increments the development prerelease number; write the target version into the plan before execution. Do not merge planning artifacts alone under the old version. Write each detailed plan just in time; roadmap acceptance records are not substitutes for runnable plans.

| # | Title | Status | Plan file | Target version |
| --- | --- | --- | --- | --- |
| 5 | Expose precise failure and lifecycle evidence | merged to `develop` in PR #17 | Retired after merge | `0.3.0-dev.7` |
| 6 | Enable native TypeSafe inference and verify a realistic author journey | merged to `develop` in PR #18 | Retired after merge | `0.3.0-dev.8` |
| 7 | Resume eligible respondent-local failures in partial journeys | merged to `develop` in PR #19 | Retired after merge | `0.3.0-dev.9` |
| 8 | Ship one reproducible self-contained plugin package across Git and ZIP | active; plan written JIT | [Plan 8](08-self-contained-marketplace-package.md) | `0.3.0-dev.10` |
| 9 | Establish datastore upgrade compatibility from the 0.3.0 baseline | pending; plan written JIT | Not authored yet | `0.3.0-dev.11` |
| 10 | Reconcile guidance and verify the installed author journey | pending; plan written JIT | Not authored yet | `0.3.0-dev.12` |

## Plan 8: self-contained marketplace package

Generate a tracked `plugins/sheg/` package from canonical repository source and point the existing `.agents/plugins/marketplace.json` entry at `./plugins/sheg`. Keep plugin name, marketplace name, display name, installation policy and authentication policy unchanged. The generated package contains only the portable manifests, a minimal runtime `package.json` carrying the generated version and module type, built `dist/` runtime and required helper/data assets, shipped skills and references without skill behavior tests, and the license. It excludes implementation source, dependencies, tests, plans, development guidance, build scripts, and unrelated repository files. Root `package.json` remains the single authored product version; the generated manifests and package are reproducible build outputs.

Make the release ZIP a deterministic archive of that same package directory, with package-root paths, and verify equivalence by comparing its extracted runtime tree byte-for-byte with `plugins/sheg/`. Build and test installation from a copied package with no checkout, node_modules, source or local build. Verify MCP, worker, Windows credential helper, archetype data, skill references and schemas resolve inside the installed root. Prove marketplace source-path resolution uses the repository root and installs only the declared plugin directory. Preserve the marketplace identity, plugin identity and existing `PLUGIN_DATA`/OS application-data locations so changing the source path does not strand durable runs. The develop branch carries its generated prerelease package; the stable release branch inherits that package from develop and the release ZIP is built from it, with no manual second allowlist. No tag or publication is part of this plan.

Acceptance: a clean generated package diff is reproducible; source and ZIP have exactly equivalent runtime files and bytes; forbidden development files are absent; the real Git marketplace install or an equivalent Codex-resolved local marketplace install materializes only the package; an installed-copy MCP handshake and worker lifecycle succeed without repository files or dependency installation; product version resolves from the one authored source; and a datastore identity/path check proves existing run lookup remains unchanged by the marketplace path migration. Include meaningful generation, path, exclusion and copied-package tests, never receipt artifacts.

## Plan 9: datastore upgrade compatibility

The merged lifecycle contract deliberately refuses every partial journey, and respondent-local failure settlement clears the failed turn identifiers. Change that runtime contract so `run_resume` can retry eligible failed journey work under the same run ID and original remaining call allowance while preserving completed answers, respondent-specific exposure/response history, route choices, reached-turn order and physical-attempt history. A failed retry remains visible and resumable only when safe. Never replay successful respondents or earlier reached turns, widen the allowance, or retry unresolved/uncertain provider attempts. Prove the reported eligibility and actual transition agree, with refusal for cancellation, exhausted allowance and unresolved attempts. Update the polling guidance and add a behavior scenario for explaining and explicitly resuming a partial journey.

## Plan 8: datastore upgrade compatibility

Make the final 0.3.0 candidate the first supported SQLite schema baseline. Development prerelease datastores remain disposable and need not migrate; after 0.3.0, every schema-changing release must ship a tested forward migration from each supported prior schema. Keep migrations sequential, transactional and data-preserving, with a verified pre-migration backup and integrity checks. Version and upcast persisted JSON payloads separately where their contracts evolve; preserve frozen requests, packets, answers, lineage and physical-attempt accounting as historical evidence rather than silently reinterpreting them. Do not automatically reset data when migration fails or when a newer unsupported schema is found.

Ensure MCP startup remains useful when datastore opening or migration fails. Register a bounded maintenance/recovery surface that can report compatibility and migration state and provide safe export or explicitly confirmed reset options without exposing credentials or raw SQL. Ordinary study tools must refuse writes while recovery is required. A failed migration leaves the original database recoverable and explains the next action. Supersede ADR-0018 with the post-0.3.0 compatibility promise and its supported-schema policy.

Acceptance: source-owned schema fixtures represent the 0.3.0 baseline and each supported migration input; automated tests prove data and accounting preservation across every migration step, transaction rollback on failure, refusal of unknown future schemas without mutation, and actionable maintenance access when normal startup cannot open the store. Future schema changes cannot merge without the corresponding migration and upgrade tests. These are tests and fixtures, not retained campaign results or development receipts.

## Plan 10: combined guidance and installed proof

Own the study-design and comparison/interpretation guidance, the stale cohort-minimization wording, version-policy instructions that currently sound like manual synchronization, and final package integration scenarios. Explain purposeful variation across respondent profile, stimulus, question/response and state; identical fingerprints do not add substantive coverage, and cohorts should cover meaningful profile differences rather than default to the smallest size. State that `package.json` is the sole authored product version and build/package generation owns downstream copies. This final slice checks the conversation as a whole: staged reading, material selection, isolated reuse, changed framing, a local failure, explicit journey resume with preserved progress, durable recall, the 0.3.0 datastore upgrade contract, and both prerelease and stable package paths. Read current skills as an agent receives them; run versioned fresh-context scenarios with fixed criteria and transient campaign outputs. Include cases where an identical input is repeated and where one input dimension changes purposefully. Report strengths preserved and remaining limitations.

## Validation and handoff

Each executable plan specifies files, behavioral proof, and commands. Regenerate canonical contracts/runtime before committing changes that affect them. Let the tracked pre-commit hook run `npm run verify` against the staged snapshot; never bypass it. Do not immediately repeat the same full gate without a new change or unresolved concern. Focused tests and build evidence supplement that gate. Skill behavior campaigns run only when explicitly invoked, stay outside CI and pre-commit, and their outputs are inspected during development then discarded; source-owned scenarios and calibration fixtures remain with the skills, and deterministic harness tests remain under `test/`.

Execution is sequential through `executing-plans`: context, follow-on and lifecycle contracts share persisted packets, compiler identity, generated contracts and agent guidance. Scenario actors are fresh by design; that is a test requirement, not permission to delegate implementation.

The continuing objective authorizes implementation, a PR into `develop`, and a merge after fresh review and required checks pass. It does not authorize a stable release tag or GitHub Release. The user separately authorized paid native TypeSafe validation for an initial budget of 500 API calls; seek authorization before exceeding it. Git history records completed development work. No paid call budget transfers from the Portfolio pilot.
