# SemVer and version alignment

## When

Use when selecting a release version, changing release metadata, or preparing a tag.

## Required capabilities

The agent must compare the proposed bundle with the public compatibility contract and verify every authoritative version field and release tag.

## Optional capabilities

Release-note generation may help summarize user-visible changes.

## Required repository-owned skills

None.

## Optional repository-owned skills

None.

## Composition

Before `1.0.0`, increment the patch for compatible fixes and the minor version for a coherent backward-compatible functionality bundle. Document breaking changes clearly. Do not bump on every merge. Keep `package.json` and `plugin.json` versions equal. Tag a release as `v<version>` only after the release PR is merged to `main`; the tag and manifests must agree. Reserve `1.0.0` for a stable usable product with an explicitly declared compatibility contract. After promotion, reconcile the release commit into `develop` so fixes and version metadata are retained.

## Doctrine and contracts

The tagged Git commit is source truth. `package.json` remains private; the release artifact is the self-contained Codex plugin ZIP. The current compatibility declaration is in `docs/guides/releases.md`.

## Local commands and paths

Use `npm run verify`, `npm run build`, and the release packaging command before tagging. The tag-triggered workflow rejects invalid or mismatched versions before publication.

## Evidence contract

Report the selected SemVer version, why patch or minor applies, compatibility impact, matching manifest values, tag commit, and ZIP contents.

## Prohibited combinations

Do not infer a version bump from arbitrary commits, publish from an unverified tag, or publish to npm.

## Composition

- Apply [Gitflow branch and release routing](gitflow-branch-and-release.md) for the release branch and reconciliation path.

## Runbook routing

- [Implementing](../runbooks/implementing.md)
- [Pull request](../runbooks/pr.md)
