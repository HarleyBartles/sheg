# Gitflow and Versioned Plugin Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a repeatable Gitflow process, SemVer-aligned Codex plugin releases, and validated runbook/playbook guidance for Sheg.

**Architecture:** Keep `main` as the stable release line and `develop` as the integration/default branch. Build a tagged plugin ZIP from the repository's existing self-contained `dist/` output, and use the selected repository composition standards to route implementing and PR stages into the branch and version playbooks.

**Tech Stack:** GitHub Actions, Node.js/npm, TypeScript build, GitHub CLI/API, repository operating-standard deployment and composition checks.

**Spec:** Linear issue SHEG-4, `https://linear.app/harleys-workspace/issue/SHEG-4/establish-gitflow-and-versioned-plugin-releases` (full issue retrieved; no linked Linear documents).

**Execution Strategy:** `executing-plans` because branch settings, standards deployment, package contents, and release automation share ordering and must be reviewed as one integrated workflow; an agent-per-task lane would add context reconstruction around mutable branch and policy state. No parallel tracks are used.

## Global Constraints

- Preserve `package.json` `private: true`; do not publish to npm.
- Keep `package.json` and `plugin.json` versions synchronized.
- Start from `v0.1.0`; patch is for compatible fixes and minor for coherent backward-compatible functionality bundles before v1.
- Reserve `1.0.0` for a stable usable product with a declared compatibility contract.
- Codex is the only supported harness implemented in this issue.
- Subscribe only to `runbook-composition` and `playbook-composition`; do not name ambient skills as workflow dependencies.
- Feature PRs target `develop`; release PRs target `main` from `release/<version>`; document urgent hotfix routing.
- Git tags are release source truth; normal merges to `develop` never publish stable releases or change versions.
- Preserve existing Git-based marketplace installation as a supported route.

## Review Focus

- Incorrect tag or mismatched manifest version must fail before a GitHub Release is created.
- Release ZIP must be reproducible from the tagged built output and contain no source checkout requirements, `node_modules`, or development dependencies.
- Release fixes and version metadata must return to `develop` after promotion.
- CI must run for PRs targeting `develop`, `main`, and release branches; only tag workflow publishes.
- Branch/default settings unavailable to automation must be stated as exact owner actions.

---

### Task 1: Retire prior completed plans and record the release implementation plan

**Files:**
- Delete only standalone `.agents/plans/*.md` files explicitly marked `completed-awaiting-retirement` and not retained by an active unmarked roadmap/spec bundle.
- Create `.agents/plans/2026-09-30-gitflow-versioned-plugin-releases.md`.
- Preserve the unmarked smallest-executable-study roadmap/spec and the three completed child plans they still index; do not infer their retirement marker.

**Interfaces:**
- Consumes: current main snapshot at `976aa05d1c8219e50ca5b9dcae262469a21244bf`.
- Produces: a committed executable plan and a clean worktree except the active plan.

- [ ] Confirm there are no inbound references to each candidate retirement file and that durable decisions have been promoted to ADRs/current contracts.
- [ ] Remove only the independently marked and unreferenced completed plans; retain the referenced roadmap bundle.
- [ ] Save and self-review this plan against every SHEG-4 scope, guardrail, and validation item.
- [ ] Commit the retirement and plan as the first task commit; allow the tracked pre-commit hook to run its canonical gate.

### Task 2: Pin and deploy the two adopted operating standards

**Files:**
- Create `.gitmodules` and `.agents/plugins/marketplace-source` submodule pinned to the reviewed Agent Asset Marketplace commit.
- Create `.agents/contracts/operating-standards.json` selecting only runbook-composition and playbook-composition.
- Generate only standard-owned deployed resources and provenance outputs using the marketplace migration/deployment commands.
- Modify `.agents/plugins/marketplace.json` only if the standard checks show it is required; plugin availability does not select standards.

**Interfaces:**
- Consumes: pinned marketplace standard source at commit `3b39cc051f1fb4241c9ee36a1fca411190f9b1a8`.
- Produces: reproducible standard check/apply declarations with source provenance and the two standards' contract resources.

- [ ] Inspect the pinned source and use its migration preview to determine exact contract schema and generated paths.
- [ ] Add the submodule at the reviewed commit and run `git submodule update` to verify the pin.
- [ ] Declare exactly the selected two standards and deploy their resources with the documented `--prepare-migration` sequence.
- [ ] Run each selected standard's check and confirm no unrelated standard is declared or generated.

### Task 3: Create Gitflow branch and CI routing

**Files:**
- Modify `.github/workflows/ci.yml` to include PR targets `develop`, `main`, and `release/**` while preserving `npm run verify`.
- Update root `AGENTS.md` with a concise pointer to repo policy and stage routing.
- Create runbook/playbook policy and initial four documents in the paths prescribed by the selected standards.
- Update README or focused release guide with branch targets and urgent fix route.

**Interfaces:**
- Consumes: standards deployed in Task 2.
- Produces: agents can resolve implementing and PR lifecycle roots and their topical playbooks using declared paths.

- [ ] Create/verify remote `develop` at the current PR 5 merge commit, then set GitHub default branch to `develop`; verify `main` remains at PR 5.
- [ ] Define an implementing runbook and PR runbook, plus Gitflow branch/release routing and SemVer/version-alignment playbooks.
- [ ] Describe capabilities in ordinary language; required unavailable capability blocks dependent work, optional unavailable capability is reported and skipped.
- [ ] Declare paths and composition edges in repository policy; ensure implementing/PR guidance routes features to develop and releases to main.
- [ ] Add a red/green behavioral or structural proof only where the adopted standards do not already prove the behavior; do not add tautological or change-detector tests.
- [ ] Run the selected standards' structural checks and resolve all diagnostics.

### Task 4: Implement reproducible plugin release packaging

**Files:**
- Create a focused release packaging script under `scripts/`.
- Modify `package.json` scripts only as needed to expose the build/package command.
- Create or modify a focused release guide describing ZIP contents and extraction/install steps.
- Add relevant behavior coverage under the existing `test/` responsibility layout.

**Interfaces:**
- Consumes: built `dist/`, root plugin manifests, marketplace entry, `skills/`.
- Produces: deterministic ZIP containing the plugin install root and no `node_modules` or build toolchain.

- [ ] Inspect the existing marketplace manifest and build output to define the exact installable ZIP root.
- [ ] Add packaging behavior and focused tests for included required files and excluded development files.
- [ ] Build and package twice from the same source and prove archive contents are stable and complete.
- [ ] Inspect the archive listing and test documented extraction/install steps without npm publication.

### Task 5: Implement tag-verified GitHub Release workflow

**Files:**
- Create `.github/workflows/release.yml` triggered only by `v*` tags.
- Modify release scripts/tests from Task 4 only where version/tag validation belongs.
- Update release guide and SemVer playbook with retries, failure behavior, promotion, and merge-back.

**Interfaces:**
- Consumes: packaging command from Task 4.
- Produces: verified tag creates GitHub Release with generated notes and plugin ZIP; invalid tag/version publishes nothing.

- [ ] Validate strict `vMAJOR.MINOR.PATCH` and equality with `package.json` and `plugin.json` before release creation.
- [ ] Workflow runs `npm ci`, `npm run verify`, production build, and package generation before GitHub Release publication.
- [ ] Grant minimum token permissions for release creation; ensure ordinary PRs and develop pushes cannot publish.
- [ ] Use a non-production test repository/tag or workflow-level dry run to prove valid and mismatched paths without polluting Sheg's public release history.
- [ ] Document release/<version> stabilization-only edits, main promotion, tag identity, reconciliation into develop, patch/minor decision, hotfix path, retry safety, and v1 compatibility threshold.

### Task 6: Verify the full contract and prepare review handoff

**Files:**
- Review all Task 2-5 changed files; update the active plan with completed evidence and mark it `completed-awaiting-retirement` before PR handoff.

**Interfaces:**
- Consumes: all preceding task outputs.
- Produces: reviewable draft PR targeting `develop`, with exact validation and branch settings evidence.

- [ ] Run `npm run verify` and the production build as required by SHEG-4.
- [ ] Run the selected standards' checks and inspect exact runbook/playbook routes and capability declarations.
- [ ] Verify CI branch triggers, release workflow tag-only behavior, invalid tag rejection, and archive listing.
- [ ] Verify default branch is develop and protections enforce CI on develop and reviewed release PRs on main, or record the exact settings owner action.
- [ ] Request a fresh code review and resolve actionable findings before handoff.
- [ ] Create a Draft PR targeting `develop`, link SHEG-4, and report worktree, branch, base, initial status, final head, changed files, validations, archive listing, workflow evidence, branch settings, and owner actions.
