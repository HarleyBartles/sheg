# Architecture Decision Records

This directory records durable decisions for Sheg: the context in
which each decision was made, the alternatives considered, and its consequences.
The records are part of the repository so future contributors can read them
alongside the code.

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
| [0010](0010-preflight-study-context-for-configured-providers.md) | Preflight study context for configured providers | Proposed |
| [0011](0011-deterministic-study-preview-and-packet-sizing.md) | Share packet assembly and expose deterministic study preview and sizing | Partially superseded by 0016 |
| [0012](0012-system-one-typed-responses-and-routing.md) | Preserve typed System One responses and route explicitly | Accepted |
| [0013](0013-gitflow-and-tagged-plugin-releases.md) | Use Gitflow and tagged plugin releases | Accepted |
| [0014](0014-route-jev-execution-explicitly.md) | Select Jev routes explicitly and include route identity | Accepted |
| [0015](0015-store-jev-credentials-in-windows-vault.md) | Store Jev credentials in Windows Credential Manager | Accepted |
| [0016](0016-bound-provider-attempts-without-spend-accounting.md) | Bound provider attempts without spend accounting | Accepted |

| [0017](0017-limit-jev-credential-destinations.md) | Limit Jev credential destinations to the selected provider | Accepted |
| [0018](0018-store-durable-runs-in-sqlite.md) | Store durable runs in local SQLite | Accepted |
| [0019](0019-own-execution-in-detached-workers.md) | Own accepted run execution in detached workers | Accepted |
| [0020](0020-snapshot-follow-on-contexts.md) | Snapshot follow-on contexts with separate lineage | Accepted |

## Writing and changing decisions

Create one numbered record for each consequential decision. Include its status,
context, considered options, decision, and consequences. Keep implementation
plans as temporary working files; this directory records why the durable
choices were made. Completed plans remain in Git history. When a decision
changes, add a new record that supersedes the old one
instead of rewriting history. Update this index in the same change.

Use [the template](template.md) for new records. Not every implementation choice
needs an ADR; record choices that constrain future architecture, interfaces,
distribution, or operations.
