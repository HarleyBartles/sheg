# Gitflow and Versioned Plugin Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a repeatable Gitflow process, SemVer-aligned Codex plugin releases, and validated runbook/playbook guidance for Sheg.

**Architecture:** Keep `main` as the stable release line and `develop` as the integration/default branch. Build a tagged plugin ZIP from the repository's existing self-contained `dist/` output, and use Sheg-owned runbooks, playbooks, and doctrine to route contribution stages into branch and version workflows.

**Tech Stack:** GitHub Actions, Node.js/npm, TypeScript build, GitHub CLI/API, Sheg-owned workflow documentation.

**Spec:** Linear issue SHEG-4, `https://linear.app/harleys-workspace/issue/SHEG-4/establish-gitflow-and-versioned-plugin-releases` (full issue retrieved; no linked Linear documents).

**Execution Strategy:** `executing-plans` because branch settings, Sheg-owned workflow composition, package contents, and release automation share ordering and must be reviewed as one integrated workflow; an agent-per-task lane would add context reconstruction around mutable branch and policy state.

## Global Constraints

- Preserve `package.json` `private: true`; do not publish to npm.
- Keep `package.json`, both root `package-lock.json` version fields, and `plugin.json` versions synchronized.
- Start from `v0.1.0`; patch is for compatible fixes and minor for coherent backward-compatible functionality bundles before v1.
- Reserve `1.0.0` for a stable usable product with a declared compatibility contract.
- Codex is the only supported harness implemented in this issue.
- Keep workflow documentation and capability composition repository-owned; do not subscribe to external operating standards or name ambient skills as workflow dependencies.
- Feature PRs target `develop`; release PRs target `main` from `release/<version>`; document urgent hotfix routing.
- Git tags are release source truth; normal merges to `develop` never publish stable releases or change versions.
- Preserve existing Git-based marketplace installation as a supported route.

## Review Focus

- Incorrect tag or mismatched package, plugin, or lockfile version must fail before dependency installation and release publication.
- Release ZIP must be reproducible from the tagged built output and contain no source checkout requirements, `node_modules`, or development dependencies.
- Release fixes and version metadata must return to `develop` after promotion.
- CI must run for PRs targeting `develop`, `main`, and release branches; only tag workflow publishes.
- Branch/default/tag settings unavailable to automation must be stated as exact owner actions.

**Handoff status:** `completed-awaiting-retirement`. Keep this plan through the
SHEG-4 PR; retire it after the work is merged and the next slice begins.

**Implementation evidence:** `npm run verify` passed locally and again in the
tracked pre-commit hook (164 tests); `npm run build` passed; all four focused
release packaging tests passed; `npm run plugin:package -- --tag v0.1.0`
created a deterministic 25-file archive. Both workflow YAML files parse, all
runbook/playbook links resolve, and the Sheg-owned policy contains no required
ambient plugin or skill identifiers. The GitHub default branch and protection
rules were verified live. PR [#6](https://github.com/HarleyBartles/sheg/pull/6) targets `develop`; its initial head was `15108fc930526d83b5527142f734bfec6b5c35af`.
An independent review at `df2841ffb262480014907ed11db19db331c5cc98` resolved its
actionable findings. A later review of the evidence update found that the
release workflow checked out a mutable tag ref and that this review record was
stale. This iteration pins source checkouts to the push event commit, checks
that the local tag resolves to that commit before release work, checks the live
GitHub tag again before publication, and adds annotated-tag retargeting
behavior coverage. The fresh review cycle covers these corrections before
handoff. The final PR check and exact head are available from GitHub. In private
validation repository `HarleyBartles/sheg-release-workflow-validation`, tag
`v0.1.0` completed all release jobs and published a 25-file
`sheg-v0.1.0.zip` (SHA-256
`4d02ff98a85d5b2b92f2114231476aad2338eef76150a90f4d87b30263094823`); tag
`v0.1.1` failed manifest/tag validation before build and publish, leaving no
second release. The test release, tag refs, and main branch were removed. GitHub
denied deleting the private repository because the current login lacks the
`delete_repo` OAuth scope; the empty private repository and a cleanup branch
remain. No public Sheg release or npm publication was created.

---

### Task 1: Retire prior completed plans and record the release implementation plan

**Files:**
- Delete completed `.agents/plans/*.md`, roadmaps, and specs from the completed SHEG-2 study bundle as directed by the user.
- Create `.agents/plans/2026-09-30-gitflow-versioned-plugin-releases.md`.
- Retain the active SHEG-4 plan through its completing PR.

**Interfaces:**
- Consumes: current main snapshot at `976aa05d1c8219e50ca5b9dcae262469a21244bf`.
- Produces: a committed executable plan and a clean worktree except the active plan.

- [x] Confirm the completed study decisions are represented in ADR-0012 and current contracts, then retire the completed SHEG-2 study spec, roadmap, and child plans as directed.
- [x] Retire the standalone completed PR and audit plans with no live references.
- [x] Save and self-review this plan against every SHEG-4 scope, guardrail, and validation item.
- [x] Commit the retirement and plan as the first task commit; allow the tracked pre-commit hook to run its canonical gate.

### Task 2: Remove scaffolded standards and retain Sheg-owned composition

**Files:**
- Remove the AOM subscription contract, pinned marketplace source submodule, generated standards and provenance, and the temporary checker.
- Remove scaffold-required baseline runbooks/playbooks, retain the implementing and PR runbooks, and retain the Gitflow and SemVer playbooks.
- Keep a concise Sheg-owned policy that declares lifecycle roots, topical workflows, composition edges, and capability selection in ordinary language.

**Interfaces:**
- Consumes: existing Sheg Gitflow and release decisions.
- Produces: a small standalone composition policy and no external standards subscription.

- [x] Remove all AOM subscription and scaffolder-generated assets from the repository.
- [x] Retain only the four intended workflow documents and replace standard-specific policy with Sheg-owned composition and capability guidance.
- [x] Check that every composition link resolves and that no workflow requires a named ambient plugin or skill.

### Task 3: Create Gitflow branch and CI routing

**Files:**
- Modify `.github/workflows/ci.yml` to include PR targets `develop`, `main`, and `release/**` while preserving `npm run verify`.
- Update root `AGENTS.md` with a concise pointer to repo policy and stage routing.
- Create the runbook/playbook policy and the four SHEG-4 lifecycle/topic documents. Retain no scaffold-required baseline books.
- Update README or focused release guide with branch targets and urgent fix route.

**Interfaces:**
- Consumes: Sheg-owned policy and workflow documents defined in Task 2.
- Produces: agents can resolve implementing and PR lifecycle roots and their topical playbooks using declared paths.

- [x] Create/verify remote `develop` at the current PR 5 merge commit, then set GitHub default branch to `develop`; verify `main` remains at PR 5.
- [x] Define an implementing runbook and PR runbook, plus Gitflow branch/release routing and SemVer/version-alignment playbooks.
- [x] Describe capabilities in ordinary language; required unavailable capability blocks dependent work, optional unavailable capability is reported and skipped.
- [x] Declare paths and composition edges in repository policy; ensure implementing/PR guidance routes features to develop and releases to main.
- [x] Add a red/green behavioral or structural proof only where an existing focused check does not already prove the behavior; do not add tautological or change-detector tests.
- [x] Review the declared composition edges and capability wording as Sheg-owned guidance.

### Task 4: Implement reproducible plugin release packaging

**Files:**
- Create a focused release packaging script under `scripts/`.
- Modify `package.json` scripts only as needed to expose the build/package command.
- Create or modify a focused release guide describing ZIP contents and extraction/install steps.
- Add relevant behavior coverage under the existing `test/` responsibility layout.

**Interfaces:**
- Consumes: built `dist/`, root plugin manifests, marketplace entry, `skills/`.
- Produces: deterministic ZIP containing the plugin install root and no `node_modules` or build toolchain.

- [x] Inspect the existing marketplace manifest and build output to define the exact installable ZIP root.
- [x] Add packaging behavior and focused tests for included required files and excluded development files.
- [x] Build and package twice from the same source and prove archive contents are stable and complete.
- [x] Inspect the archive listing and test documented extraction/install steps without npm publication.

### Task 5: Implement tag-verified GitHub Release workflow

**Files:**
- Create `.github/workflows/release.yml` triggered only by `v*` tags.
- Modify release scripts/tests from Task 4 only where version/tag validation belongs.
- Update release guide and SemVer playbook with retries, failure behavior, promotion, and merge-back.

**Interfaces:**
- Consumes: packaging command from Task 4.
- Produces: verified tag creates GitHub Release with generated notes and plugin ZIP; invalid tag/version publishes nothing.

- [x] Validate strict `vMAJOR.MINOR.PATCH` and equality with `package.json`, `plugin.json`, and both lockfile root versions before release creation.
- [x] Workflow runs `npm ci`, `npm run verify`, production build, and package generation before GitHub Release publication.
- [x] Grant minimum token permissions for release creation; ensure ordinary PRs and develop pushes cannot publish.
- [x] Restrict version tag creation, updates, and deletion to repository administrators.
- [x] Exercise a valid and mismatched tag/version through GitHub Actions in a private validation repository; inspect the release ZIP and remove its release, tags, and main branch without publishing to npm or creating a Sheg release.
- [x] Document release/<version> stabilization-only edits, main promotion, tag identity, reconciliation into develop, patch/minor decision, hotfix path, retry safety, and v1 compatibility threshold.

### Task 6: Verify the full contract and prepare review handoff

**Files:**
- Review all Task 2-5 changed files; update the active plan with completed evidence and mark it `completed-awaiting-retirement` before PR handoff.

**Interfaces:**
- Consumes: all preceding task outputs.
- Produces: a reviewable PR targeting `develop`, with exact validation and branch settings evidence.

- [x] Run `npm run verify` and the production build as required by SHEG-4.
- [x] Inspect exact runbook/playbook routes and capability declarations.
- [x] Verify CI branch triggers, release workflow tag-only behavior, invalid tag rejection, and archive listing.
- [x] Verify default branch is develop, protections enforce CI on develop and reviewed release PRs on main, and only administrators can create/update/delete `v*` tags.
- [x] Request an initial independent read-only review and resolve its actionable findings. Run fresh PR reviews after each correction until no new actionable issue is surfaced.
- [x] Create a Draft PR targeting `develop`, link SHEG-4, and report worktree, branch, base, initial status, final head, changed files, validations, archive listing, workflow evidence, branch settings, and owner actions.
