# ADR-0013: Use Gitflow and tagged plugin releases

- Status: Accepted
- Date: 2026-09-30

## Context

Sheg's repository is both the Codex plugin source and its package. The plugin
currently has one long-lived `main` branch, no versioned release process, and
committed generated runtime output. Agents and maintainers need one durable
answer for where feature work lands, how a coherent release is versioned, and
what users install.

## Decision

Use `develop` as the default integration branch and `main` as the stable
release line. Feature pull requests target `develop`; `release/<version>` pull
requests target `main`; urgent `hotfix/<version>` branches start from `main`
and are reconciled to `develop` after release. Reviewed tags named
`v<MAJOR>.<MINOR>.<PATCH>` identify releases.

Feature pull requests may be squash-merged. Release and hotfix promotions to
`main`, and their reconciliation into `develop`, use merge commits so the
release ancestry remains explicit.

Keep `package.json` and `plugin.json` versions equal. Before `1.0.0`, use patch
for compatible fixes and minor for coherent backward-compatible functionality
bundles. Reserve `1.0.0` for a stable usable product with a declared public
compatibility contract. Keep npm publication disabled. Build a self-contained
Codex plugin ZIP from each verified tag and attach it to a GitHub Release; the
Git tag remains source truth and Git marketplace installation remains
available.

Codex is the first supported harness. Adding another harness requires a later
decision and explicit compatibility, packaging, and validation for that
harness.

## Consequences

- Ordinary integration does not publish releases or bump product versions.
- Release automation can reject manifest/tag mismatches before publication.
- Release fixes must be reconciled into `develop` to avoid losing them from
  future work.
- The ZIP is a built artifact of the tagged plugin, not a second source package.
- Future harnesses can be added as explicit adapters while the release
  contract identifies which harnesses are supported.

## Alternatives considered

- Continue merging all work to `main` and tag ad hoc releases: this does not
  provide a stable release line while changes accumulate.
- Publish a new npm package: this is outside the product's plugin distribution
  model and adds a separate package contract.
- Add multiple harnesses to the initial release: this would claim support
  without per-harness compatibility and packaging evidence.
