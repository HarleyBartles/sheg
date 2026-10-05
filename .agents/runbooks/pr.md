# Pull request runbook

## When

Use when preparing, updating, or handing off a pull request.

## Required capabilities

The agent must be able to inspect the diff, verify the intended base branch, and report reproducible validation evidence.

## Optional capabilities

Review assistance may be used when available and appropriate.

## Required repository-owned skills

None.

## Optional repository-owned skills

None.

## Composition

Feature PRs target `develop`. Release PRs target `main` from `release/<version>`; hotfix PRs target `main` from `hotfix/<version>`. A completed release must be reconciled back into `develop`.

## Doctrine and contracts

Follow the [operating standards certification](../contracts/standards-certification.md), applicable playbooks, and approved work plan.

## Local commands and paths

Run `npm run verify` and `npm run build` for release-bound work. GitHub Actions validates PRs to `develop`, `main`, and `release/**`.

## Evidence contract

Include PR URL, base/head branches, final head SHA, changed files, validation results, and release artifact evidence where applicable.

## Prohibited combinations

Do not merge ordinary feature work into `main`, publish a release from an unverified tag, or omit release-fix reconciliation.

## Playbook routing

- [Source quality](../playbooks/source-quality.md) - for reviewing source, tests, generated runtime output, persisted contracts, providers, and entrypoints. Read applicable Unslop profiles, assess whether the guards were reachable and useful, and record only distinct evidence.
- [Gitflow branch and release routing](../playbooks/gitflow-branch-and-release.md) - for branch choice, PR target, release, or hotfix.
- [SemVer and version alignment](../playbooks/semver-version-alignment.md) - when versions change or a release is prepared.
