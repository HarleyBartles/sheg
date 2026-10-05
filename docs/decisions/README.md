# Architecture Decision Records

This directory records durable decisions for Sheg: the context in which each decision was made, the alternatives considered, and its consequences. The records are part of the repository so future contributors can read them alongside the code.

## Records

| ID | Decision | Status |
| --- | --- | --- |
| [0001](0001-keep-adrs-in-the-repository.md) | Keep ADRs in the repository root | Superseded by 0006 |
| [0002](0002-use-node-and-typescript.md) | Use Node.js and TypeScript | Accepted |
| [0003](0003-use-domain-neutral-polling-primitives.md) | Model polls with domain-neutral primitives and an explicit graph | Superseded by 0008 |
| [0004](0004-organize-source-by-responsibility.md) | Organize source by responsibility and keep tests separate | Accepted |
| [0005](0005-distribute-as-an-ambient-codex-plugin.md) | Distribute as an ambient Codex plugin | Accepted |
| [0006](0006-store-adrs-in-docs-decisions.md) | Store ADRs in `docs/decisions` | Accepted |
| [0007](0007-guide-archetypes-and-freeze-reader-cohorts.md) | Guide archetype authoring and freeze study-specific reader profiles | Superseded by 0008 |
| [0008](0008-model-stimulus-task-respondent-and-matched-arms.md) | Model stimulus, task, respondent, and matched arms | Archetype taxonomy superseded by 0009 |
| [0009](0009-generalize-and-group-respondent-archetypes.md) | Generalize and group respondent archetypes | Accepted |
| [0010](0010-preflight-study-context-for-configured-providers.md) | Preflight study context for configured providers | Proposed; durable-run admission superseded by 0032 |
| [0011](0011-deterministic-study-preview-and-packet-sizing.md) | Share packet assembly and expose deterministic study preview and sizing | Partially superseded by 0016 and 0032 |
| [0012](0012-system-one-typed-responses-and-routing.md) | Preserve typed System One responses and route explicitly | Accepted |
| [0013](0013-gitflow-and-tagged-plugin-releases.md) | Use Gitflow and tagged plugin releases | Accepted |
| [0014](0014-route-jev-execution-explicitly.md) | Select Jev routes explicitly and include route identity | Accepted |
| [0015](0015-store-jev-credentials-in-windows-vault.md) | Store Jev credentials in Windows Credential Manager | Accepted |
| [0016](0016-bound-provider-attempts-without-spend-accounting.md) | Bound provider attempts without spend accounting | Accepted |
| [0017](0017-limit-jev-credential-destinations.md) | Limit Jev credential destinations to the selected provider | Accepted |
| [0018](0018-store-durable-runs-in-sqlite.md) | Store durable runs in local SQLite | CLI persistence boundary superseded by 0029; schema policy by 0027 |
| [0019](0019-own-execution-in-detached-workers.md) | Own accepted run execution in detached workers | Accepted |
| [0020](0020-snapshot-follow-on-contexts.md) | Snapshot follow-on contexts with separate lineage | Accepted |
| [0021](0021-independent-question-groups-and-batched-attempts.md) | Independent question groups share context and separate evidence | Accepted |
| [0022](0022-source-linked-material-choices.md) | Link offered Choice options to exact source material | Accepted |
| [0023](0023-identify-development-and-candidate-builds.md) | Identify development and candidate builds | Accepted |
| [0024](0024-normalize-journeys-and-version-packet-context.md) | Normalize journeys and version packet context | Accepted |
| [0025](0025-bound-native-typesafe-context-admission.md) | Bound native TypeSafe context admission with published evidence | Accepted |
| [0026](0026-resume-failed-journey-turns.md) | Resume respondent-local failures in partial journeys | Accepted |
| [0027](0027-migrate-supported-datastore-schemas.md) | Migrate supported datastore schemas forward | Accepted |
| [0028](0028-keep-planning-artifacts-off-main.md) | Keep planning artifacts off the stable release tree | Accepted |
| [0029](0029-share-the-durable-run-system-across-entrypoints.md) | Share the durable run system across entrypoints | Accepted |
| [0030](0030-use-drizzle-behind-typed-run-repositories.md) | Use Drizzle behind typed run repositories | Accepted |
| [0031](0031-set-schema-nine-as-release-baseline.md) | Set schema 9 as the v0.3.0 release baseline | Accepted |
| [0032](0032-admit-journey-turns-as-they-are-reached.md) | Admit journey turns as they are reached | Accepted |

## Writing and changing decisions

Create one numbered record for each consequential decision. Include its status, context, considered options, decision, and consequences. When a decision changes, add a new record that supersedes the old one instead of rewriting history. Update this index in the same change. The [release guide](../guides/releases.md#branches-and-promotion) governs planning artifact residency.

Use [the template](template.md) for new records. Not every implementation choice needs an ADR; record choices that constrain future architecture, interfaces, distribution, or operations.
