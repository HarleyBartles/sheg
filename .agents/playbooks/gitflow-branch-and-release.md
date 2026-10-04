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

Apply [version alignment](semver-version-alignment.md) for deliberate development checkpoints and releases. Follow the [release guide](../../docs/guides/releases.md#branches-and-promotion) for planning artifact exclusion and reconciliation custody.

## Local commands and paths

CI validates pull requests targeting `develop`, `main`, and `release/**`. GitHub rules require pull requests and the `sheg-verify` status check on the stable and integration branches.

## Evidence contract

Before handoff, report source branch, target branch, base SHA, final head SHA, and the PR URL.

## Prohibited combinations

Do not target `main` from an ordinary feature branch, add unrelated features to a release branch, or leave release fixes only on `main`.

## Runbook routing

- [Implementing](../runbooks/implementing.md)
- [Pull request](../runbooks/pr.md)
