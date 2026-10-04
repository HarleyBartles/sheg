# SemVer and version alignment

## When

Use when selecting a release version, changing release metadata, or preparing a tag.

## Required capabilities

The agent must assess compatibility, select a version, regenerate derived identities, and validate the resulting package and any proposed release tag.

## Optional capabilities

Release-note generation may help summarize user-visible changes.

## Required repository-owned skills

None.

## Optional repository-owned skills

None.

## Composition

Select the version using the [release guide's version policy](../../docs/guides/releases.md#version-policy). Edit only root `package.json`, run `npm run build`, and inspect the generated lockfile, manifests, runtime, and package. Run `npm run verify` and tagged package validation before publication.

Apply [Gitflow routing](gitflow-branch-and-release.md) for promotion and reconciliation. A release tag is created only after its reviewed release PR merges to `main`; a development version or local archive does not publish a release.

## Doctrine and contracts

The tagged Git commit is source truth. `package.json` remains private; the release artifact is the self-contained Codex plugin ZIP. The current compatibility declaration is in `docs/guides/releases.md`.

## Local commands and paths

Use `npm run plugin:package -- --tag "v<version>" --validate-only`, substituting the selected stable version, to validate release identity. The tag-triggered workflow also checks main ancestry before publication.

## Evidence contract

Report the selected SemVer version, why patch or minor applies, compatibility impact, matching manifest values, tag commit, and ZIP contents.

## Prohibited combinations

Do not infer a version bump from arbitrary commits, publish from an unverified tag, or publish to npm.

## Runbook routing

- [Implementing](../runbooks/implementing.md)
- [Pull request](../runbooks/pr.md)
