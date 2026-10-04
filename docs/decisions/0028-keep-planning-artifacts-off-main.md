# ADR-0028: Keep planning artifacts off the stable release tree

- Status: Accepted
- Date: 2026-10-04
- Supersedes: None

## Context

Plans, specifications, roadmaps, and similar artifacts coordinate active work on `develop`. They describe intended work and become stale after delivery; stable releases need maintained product documentation instead.

## Options considered

- Keep completed planning files in the stable tree as project history, which leaves outdated plans beside maintained product documentation.
- Remove planning files when preparing each release, while keeping durable decisions and operating guidance in their maintained documentation homes.

## Decision

Treat plans, specifications, roadmaps, and similar planning artifacts as temporary Git-resident work files on `develop`. Before a release branch is promoted to `main`, remove the contents of `.agents/plans/` and `.agents/specs/`. Promote durable decisions to `docs/decisions/` and maintained operating rules to their current guides, runbooks, or playbooks before removing the planning artifacts.

Git history retains the historical planning context.

## Consequences

Release preparation checks the final tree for planning files. Reconciliation preserves active or mixed-scope planning artifacts from the pre-reconciliation `develop` tree while keeping completed artifacts retired. The [release guide](../guides/releases.md#branches-and-promotion) owns the operational procedure.
