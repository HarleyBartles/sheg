# Gitflow branch and release routing

## When

Use whenever choosing a branch base or PR target, assembling a release, or preparing an urgent production fix.

## Required capabilities

The agent must inspect the current branch and remote refs, identify the work type, and explain its branch/PR route.

## Optional capabilities

Git hosting tools may be used to inspect or configure repository branch settings when authorized.

## Required repository-owned skills

None.

## Optional repository-owned skills

None.

## Composition

Ordinary feature branches start from the latest `develop` and PRs target `develop`; feature PRs may use squash merge. A release branch `release/<version>` starts from `develop`, accepts release preparation and stabilization fixes only, then targets `main` with a merge commit. Reconcile the release into `develop` with a merge commit. An urgent fix starts from `main` on `hotfix/<version>`, targets `main` with a merge commit, is tagged after verification, then is reconciled into `develop` with a merge commit.

## Doctrine and contracts

`main` is the stable release line. `develop` is the integration and default branch. Tags identify releases. The release process is documented in `docs/guides/releases.md`.

Develop may carry deliberate dogfood checkpoints identified by aligned prerelease versions. Do not bump the version for every arbitrary merge. A planned checkpoint updates `package.json`, both root lockfile version fields, `plugin.json`, and the MCP initialization identity together. Stable releases continue through the release branch and use only `vMAJOR.MINOR.PATCH` tags after stable manifests are aligned and existing main-ancestry checks pass. A prerelease candidate is not a stable publication. Local no-tag packaging is for inspection and dogfooding only. See [ADR-0023](../../docs/decisions/0023-identify-development-and-candidate-builds.md).

Plans, specifications, roadmaps, and similar planning artifacts have short-lived Git residency on `develop`. Before promoting a release branch to `main`, move durable decisions and operating rules into their maintained documentation, then ensure `.agents/plans/` and `.agents/specs/` contain no planning files. During release reconciliation, preserve active or mixed-scope planning artifacts from the pre-reconciliation `develop` tree; completed or retired artifacts stay retired. See [ADR-0028](../../docs/decisions/0028-keep-planning-artifacts-off-main.md).

## Local commands and paths

CI validates pull requests targeting `develop`, `main`, and `release/**`. GitHub rules require pull requests and the `sheg-verify` status check on the stable and integration branches.

## Evidence contract

Before handoff, report source branch, target branch, base SHA, final head SHA, and the PR URL.

## Prohibited combinations

Do not target `main` from an ordinary feature branch, add unrelated features to a release branch, or leave release fixes only on `main`.

## Composition

Apply the repository's version-alignment rules whenever preparing a versioned release; the implementing and PR runbooks route to both relevant playbooks.

## Runbook routing

- [Implementing](../runbooks/implementing.md)
- [Pull request](../runbooks/pr.md)
