# ADR-0027: Migrate supported datastore schemas forward

- Status: Accepted
- Date: 2026-10-04
- Supersedes: ADR-0018's schema compatibility policy; its local SQLite storage decision remains accepted.

## Context

Sheg stores accepted runs, frozen inputs, answers, lineage, and physical provider-attempt accounting in a local SQLite database. Rejecting every schema older than the current build makes a plugin upgrade capable of removing all MCP tools before an agent can inspect or recover the database. Silent reset or reinterpretation would risk user evidence and accounting.

## Options considered

- Continue rejecting older schemas and require users to manually export or reset before upgrading. This leaves recovery inaccessible when startup fails and makes ordinary plugin updates disruptive.
- Attempt an automatic best-effort conversion without a versioned migration chain or verified backup. This risks losing or changing durable evidence.
- Maintain sequential forward migrations for released schemas, with verified backups, transactional validation, and a bounded recovery surface. This preserves evidence and leaves an explicit path when a database cannot be migrated.

## Decision

Schema 8 is the first supported released baseline in v0.3.0. Earlier development schemas are disposable and receive no compatibility promise. After v0.3.0, every schema-changing release must include a tested forward migration from each supported predecessor, applied sequentially without skipping versions.

Before each migration, create and verify a SQLite-consistent backup. Apply each step transactionally, preserve run and attempt evidence, validate SQLite integrity and foreign keys, and advance the schema version only when the step commits. If a migration fails, leave the source recoverable and report a safe actionable error. Never auto-reset, downgrade, or mutate an unknown future schema during inspection.

Keep SQLite schema versions independent from persisted JSON format versions. Evolve payloads with explicit versioned upcasters only when their own contracts change; reject unknown payload formats without rewriting their stored bytes. Historical requests, packets, answers, lineage, and physical-attempt accounting remain evidence and must not be silently reinterpreted.

When the datastore cannot open, complete MCP registration with a bounded maintenance surface that reports compatibility and backup availability. Block ordinary study and destructive run operations until recovery succeeds. A reset requires explicit confirmation and a verified SQLite backup when the database is readable; if SQLite cannot read it, quarantine the original database and sidecars before replacing the active store. Inspection never resets data, and reports distinguish a verified SQLite backup from quarantined raw files.

## Consequences

Plugin updates can migrate supported local databases while preserving durable runs. Each schema-changing release owns source fixtures and meaningful upgrade tests for its supported predecessor range. Recovery remains available when migration cannot complete, while unsupported future schemas stay untouched. Local SQLite remains tied to the configured application data root and does not claim network-share or cross-host coordination.
