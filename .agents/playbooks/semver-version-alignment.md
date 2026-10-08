# SemVer and version alignment

## Applicability

Use when selecting a release version, changing release metadata, or preparing a tag.

## Method

Assess the compatibility impact using the release guide's version policy. Edit only root `package.json`, run `npm run build`, and inspect the generated lockfile, manifests, runtime, and package. Use repository commands and Git capabilities to validate the selected identity and any proposed tag. Release-note assistance is optional and must summarize the actual product change.

For every ordinary PR into `develop`, including documentation and tooling, allocate one unique `MAJOR.MINOR.PATCH-dev.N` identity on the intended release line. Start a new core at `dev.1`; otherwise advance the current line's N. Keep one proposed identity across the PR's commits. Immediately before merge, refresh remote integration state and reallocate stale or duplicated proposals, rebuild, and reverify. Do not infer the next release core from commit count; compatibility and intended release scope own it.

Qualify release candidates as `rc.N`; source changes require the next number and renewed qualification, while identical-source reruns keep the number. Promote a verified candidate to stable and rebuild. During release or hotfix reconciliation, keep stable identity when integration is left at the released product baseline, or preserve and advance the intended next-release line when development continues. The release guide owns the complete transition rules and planning-artifact exception.

Apply the Gitflow playbook for promotion and reconciliation. Create a release tag only after its reviewed release PR merges to `main`.

## Constraints

`package.json` is the single authored version source and remains private. The tagged Git commit is release source truth; the release artifact is the self-contained Codex plugin ZIP. Do not infer a bump from arbitrary commits, edit derived version identities directly, publish from an unverified tag, or publish to npm. A development version or local ZIP does not publish a release.

## Verification

Run `npm run verify` and inspect generated parity. Use `npm run plugin:package -- --tag "v<version>" --validate-only` with the proposed stable version to validate release identity. The tag-triggered workflow checks main ancestry before publication. Report the selected version and its compatibility rationale, matching manifest identities, the tag commit when applicable, and verified ZIP contents. Version agreement proves identity consistency; runtime behavior still needs relevant package tests.

Generated parity checking builds in a disposable directory and rejects drift without repairing checkout files. For a prerelease use `npm run plugin:package -- --validate-only` without a tag. Review the proposed development identity against current `origin/develop`; parity and packaging checks do not establish checkpoint uniqueness, compatibility meaning, candidate qualification, or the correctness of a reconciliation decision.

## References and routing

Use the [implementing runbook](../runbooks/implementing.md) for metadata changes and the [PR runbook](../runbooks/pr.md) for reviewed publication. The [release guide's version policy](../../docs/guides/releases.md#version-policy) owns compatibility declarations; [Gitflow routing](gitflow-branch-and-release.md) owns promotion and reconciliation.

## Maintenance

Revisit this playbook when version ownership, compatibility declarations, generated identities, package format, or tag workflows change. Check referenced commands and routes and maintain the operating standards certification with the resulting assessment.
