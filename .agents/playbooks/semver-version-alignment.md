# SemVer and version alignment

## Applicability

Use when selecting a release version, changing release metadata, or preparing a tag.

## Method

Assess the compatibility impact using the release guide's version policy. Edit only root `package.json`, run `npm run build`, and inspect the generated lockfile, manifests, runtime, and package. Use repository commands and Git capabilities to validate the selected identity and any proposed tag. Release-note assistance is optional and must summarize the actual product change.

Apply the Gitflow playbook for promotion and reconciliation. Create a release tag only after its reviewed release PR merges to `main`.

## Constraints

`package.json` is the single authored version source and remains private. The tagged Git commit is release source truth; the release artifact is the self-contained Codex plugin ZIP. Do not infer a bump from arbitrary commits, edit derived version identities directly, publish from an unverified tag, or publish to npm. A development version or local ZIP does not publish a release.

## Verification

Run `npm run verify` and inspect generated parity. Use `npm run plugin:package -- --tag "v<version>" --validate-only` with the proposed stable version to validate release identity. The tag-triggered workflow checks main ancestry before publication. Report the selected version and its compatibility rationale, matching manifest identities, the tag commit when applicable, and verified ZIP contents. Version agreement proves identity consistency; runtime behavior still needs relevant package tests.

## References and routing

Use the [implementing runbook](../runbooks/implementing.md) for metadata changes and the [PR runbook](../runbooks/pr.md) for reviewed publication. The [release guide's version policy](../../docs/guides/releases.md#version-policy) owns compatibility declarations; [Gitflow routing](gitflow-branch-and-release.md) owns promotion and reconciliation.

## Maintenance

Revisit this playbook when version ownership, compatibility declarations, generated identities, package format, or tag workflows change. Check referenced commands and routes and maintain the operating standards certification with the resulting assessment.
