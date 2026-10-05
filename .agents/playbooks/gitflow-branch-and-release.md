# Gitflow branch and release routing

## Applicability

Use when choosing a branch base or PR target, assembling a release, or preparing an urgent production fix.

## Method

Inspect the current branch, remote refs, worktree state, and work type before selecting a route. Ordinary feature branches start from the latest `develop` and PRs target `develop`; feature PRs may use squash merge. A release branch `release/<version>` starts from `develop`, accepts release preparation and stabilization fixes, then targets `main` with a merge commit. Reconcile the release into `develop` with a merge commit. An urgent fix starts from `main` on `hotfix/<version>`, targets `main` with a merge commit, is tagged after verification, then is reconciled into `develop` with a merge commit.

Use available Git and hosting capabilities to verify refs, PR state, and merge outcomes. Apply the version-alignment playbook when selecting a development checkpoint or release identity.

## Constraints

`main` is the stable release line; `develop` is the integration and default branch. Do not target `main` from an ordinary feature branch, add unrelated features to a release branch, or leave release fixes only on `main`. Apply the release guide's planning artifact exclusion and reconciliation rules. Tags identify verified releases.

## Verification

Verify the source and target branches against current remote state, and confirm the remote PR head matches the intended commit after pushing. Report the branch route, base SHA, final head SHA, and PR URL. CI validates PRs targeting `develop`, `main`, and `release/**`; draft PR verification is skipped until ready for review. Inspect current hosting rules before relying on a required-check or merge-policy claim. Verify merge and reconciliation results before cleanup.

## References and routing

Use the [implementing runbook](../runbooks/implementing.md) for branch setup and the [PR runbook](../runbooks/pr.md) for publication and review. The [release guide](../../docs/guides/releases.md#branches-and-promotion) owns promotion and planning custody; [version alignment](semver-version-alignment.md) owns version and tag identity.

## Maintenance

Revisit this playbook when branch policy, merge strategy, release promotion, planning custody, or hosted validation changes. Check its routes and authoritative references, update the workflow inventory if applicability changes, and maintain the operating standards certification.
