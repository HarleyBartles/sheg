# ADR-0031: Set schema 9 as the v0.3.0 release baseline

- Status: Accepted
- Date: 2026-10-05
- Supersedes: ADR-0027's schema 8 baseline; its forward-migration and recovery policy remains accepted.

## Context

Before v0.3.0, the SQLite schema is still under active redesign and installed development datastores are disposable. The release schema must be strong enough to support the forward-compatibility promise that begins with v0.3.0.

## Options considered

- Preserve schema 8 as the release baseline and layer the redesigned constraints later. This ships known identity and evidence-link weaknesses into the compatibility period.
- Establish schema 9 as the new baseline and require explicit recovery for pre-release stores. This permits a coherent schema and starts migration guarantees at the released format.

## Decision

Schema 9 is the first supported released baseline. Earlier development schemas require explicit recovery and are never silently reset or migrated. From v0.3.0 onward, schema changes use sequential forward migrations with verified backups, transactional application, integrity validation, and safe failure reporting. The schema declaration and reviewed generated migration are canonical; stored payload formats have independent explicit versions and reject unknown versions without rewriting data.

## Consequences

The schema 9 baseline can include constraints and keys designed for durable run evidence without preserving pre-release database layouts. Release candidates must verify a fresh schema 9 store and exercise a test-only successor migration through the production runner. Future releases must append migrations and must not rewrite the shipped baseline migration.
