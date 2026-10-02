# Identify development and candidate builds

- Status: Accepted
- Date: 2026-10-02
- Supersedes: ADR-0013 only for the consequence that development checkpoints do not identify themselves in product manifests.

## Context

Sheg needs dogfood builds on develop to identify which product behavior and package a respondent study exercised. Stable release tags and publications must remain distinct from those builds. A version in the MCP initialization response and package manifests gives an agent a direct identity to report, while a package digest distinguishes exact archives built from that version.

## Decision

The root package manifest is the authority for product version. The package lockfile root entries, plugin manifest, and MCP initialization version must agree with it. Keep the package private and do not publish it to npm.

Use stable versions such as 0.3.0 for stable releases, 0.3.0-dev.N for deliberate development checkpoints, and 0.3.0-rc.N for prepared candidates. Increment versions at intentional checkpoints, not for every commit. The dogfood roadmap assigns 0.3.0-dev.2 through 0.3.0-dev.7 to its six planned develop merges. The existing develop identity 0.2.0 is historical dev.1 context; do not rewrite or tag it retrospectively.

Local packaging without a release tag may validate and create a prerelease ZIP for inspection and dogfood. That action does not publish a release. Stable publication accepts only vMAJOR.MINOR.PATCH tags, requires matching stable manifests, and retains the existing main-ancestry and triggering-commit checks. Prerelease tags must not publish.

Dogfood evidence should record the candidate version and, when testing an archive, its exact package digest. Generated runtime bundles derive identity from the package manifest; they must not encode a guessed Git revision or build timestamp.

## Options considered

- Keep development manifests at the last stable version and identify dogfood builds only by source revision. This leaves the MCP product identity unable to distinguish a released build from an unreleased candidate when an agent reports its runtime version.
- Increment the version for every merge to `develop`. This gives each integration commit a distinct identity but creates routine version churn unrelated to deliberate checkpoints.
- Use deliberate development and release-candidate prerelease counters, while retaining stable tags and publication as a separate release path. This identifies intentional dogfood checkpoints without changing stable publication rules.

## Consequences

Agents can report which deliberate candidate they exercised, and local candidate packages can be tested without weakening stable-release protections. A version identifies a checkpoint, not every source commit; use the source revision or archive digest when exact artifact provenance is required.
