# ADR-0037: Adopt Gitflow and SemVer with integration checkpoints

- Status: Accepted
- Date: 2026-10-08
- Partially supersedes: ADR-0023's deliberate-checkpoint allocation and ADR-0013's consequence that ordinary integration does not bump product versions. Their version ownership, branch routing, distribution, and stable-publication decisions remain in force.

## Context

Agents exercising Sheg can report the MCP product version. Reusing one deliberate checkpoint across multiple integration merges leaves that identity unable to distinguish the intervening integrated changes. AOM's independently selectable Gitflow and SemVer standards define compatible branch routes and single-source version ownership, and jointly require a distinct development identity per ordinary integration merge. Sheg needs deliberate release stabilization and adopts that joint cadence.

## Decision

Subscribe to `gitflow` and `semver` at Marketplace commit `12c86626f80cad1a2ac05b2f6690c882a3d5959a`. Explicitly migrate the subscription record to v2 without changing the IDs, immutable commits, or definition paths of the existing three subscriptions. Maintain the repository-owned implementation and certification through the existing release guide, runbooks, and playbooks.

Each ordinary merge into `develop`, including documentation and tooling changes, establishes one unique `MAJOR.MINOR.PATCH-dev.N` identity. The PR author selects the intended release core from compatibility and scope, proposes its next checkpoint, and rebuilds derived identities. Review refreshes current integration state before merge and rejects stale or duplicated proposals. Commits within a PR share its proposed identity; one squash merge is one landmark. A newly selected core starts at positive `dev.1`; subsequent merges advance N monotonically. This adoption starts the selected `0.3.1` line at `0.3.1-dev.1`.

Changed, qualified release candidates advance positive `rc.N`; identical-source verification reruns do not. Stable promotion removes the suffix and rebuilds. Reconciliation that leaves integration at the released product baseline keeps the stable identity. Reconciliation into continuing next-release work preserves that intended core and advances its checkpoint. The first development merge after a stable baseline starts the intended next core at `dev.1`. Active planning-artifact restoration does not itself constitute continuing product development.

Keep version identity separate from candidate qualification and publication. Development identities create neither Git tags nor hosted releases. Stable releases retain reviewed `main` promotion, immutable stable tags, verified matching ZIPs, and administrator-owned tag controls. Exact archive or source provenance still uses a digest or revision.

Explicit builds own generation and identity propagation. Parity validation compares a disposable build and rejects differences without changing maintained checkout files. Root `package.json` remains the single authored product version; schema, payload, dependency, and independently released product versions retain their own authorities.

## Options considered

- Retain deliberate checkpoint identities: less metadata churn, but intervening integrated builds share a product identity.
- Number every ordinary integration merge: gives agents and maintainers a distinct readable integration identity, at the cost of generation work and concurrent proposal coordination.
- Allocate versions automatically during merge or publication: avoids some manual allocation, but adds mutation machinery and a new release authority. Sheg keeps allocation in reviewed PRs.

## Consequences

Every ordinary integration PR includes its proposed version and generated identities. Authors refresh competing proposals before merge. The build and parity checks validate identity consistency; review remains responsible for compatibility meaning, checkpoint allocation, candidate qualification, release scope, and reconciliation state. The release guide owns the maintained procedure rather than this decision record serving as an execution checklist.
