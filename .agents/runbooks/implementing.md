# Implementing runbook

## When

Use while implementing an approved feature, fix, or repository workflow change.

## Required capabilities

The agent must inspect current repository state, edit the authoritative source, and verify the changed behavior using repository evidence.

## Optional capabilities

An independent reviewer may be consulted when available and useful.

## Required repository-owned skills

None.

## Optional repository-owned skills

None.

## Composition

Start feature work from the latest `develop`. Keep changes within the approved issue. Validate the staged result using the repository gate before publication.

## Doctrine and contracts

Follow `AGENTS.md`, the [operating standards certification](../contracts/standards-certification.md), `docs/decisions/README.md`, and the approved work plan. Generated `dist/` output is derived from source and build scripts.

## Local commands and paths

Run `npm ci`, `npm run verify`, and `npm run build` as the change requires. Create feature branches from `develop`; feature PRs target `develop`.

## Evidence contract

Report the worktree, base commit, initial status, changed files, commands run, results, and any remaining limitations.

## Prohibited combinations

Do not target `main` with ordinary feature work, bypass a failing gate, or edit generated output as its source.

## Playbook routing

- [Source quality](../playbooks/source-quality.md) - for source, tests, generated runtime output, persisted contracts, providers, and entrypoints. Its Method explains Sheg's corrective guides for observed agent mistakes, where they live, and which to read before editing. Follow that selection guidance, assess whether the guides helped during review, and maintain a guide only when distinct evidence warrants it.
- [Gitflow branch and release routing](../playbooks/gitflow-branch-and-release.md) - whenever selecting a base branch or PR target, or preparing a release or hotfix.
- [SemVer and version alignment](../playbooks/semver-version-alignment.md) - whenever a release version is proposed or changed.
