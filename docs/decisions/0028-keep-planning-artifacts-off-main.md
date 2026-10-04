# ADR-0028: Keep planning artifacts off the stable release tree

- Status: Accepted
- Date: 2026-10-04
- Supersedes: None

## Context

Plans, specifications, roadmaps, and similar artifacts help coordinate active work on `develop`. They become stale after the work is delivered and do not describe the stable product. Release branches cut from `develop` inherit these files, and previous stable trees have accumulated completed planning artifacts.

## Options considered

- Keep completed planning files in the stable tree as project history, which leaves outdated plans beside maintained product documentation.
- Remove planning files when preparing each release, while keeping durable decisions and operating guidance in their maintained documentation homes.

## Decision

Treat plans, specifications, roadmaps, and similar planning artifacts as temporary Git-resident work files on `develop`. Before a release branch is promoted to `main`, remove the contents of `.agents/plans/` and `.agents/specs/`. Promote durable decisions to `docs/decisions/` and maintained operating rules to their current guides, runbooks, or playbooks before removing the planning artifacts.

During release reconciliation, preserve active or mixed-scope planning artifacts from the pre-reconciliation `develop` tree. Completed or retired artifacts remain retired. The stable release tree contains no planning files; Git history remains the source for historical change context.

## Consequences

The release PR removes planning artifacts inherited from `develop` and any older planning files already on `main`. Release preparation must check the final tree and the promotion diff for plans, specifications, roadmaps, and equivalent planning files. Reconciliation must distinguish active work from completed artifacts so release cleanup does not erase ongoing development plans.
