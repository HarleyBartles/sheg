# ADR-0029: Share the durable run system across entrypoints

- Status: Accepted
- Date: 2026-10-05
- Supersedes: [ADR-0018](0018-store-durable-runs-in-sqlite.md) for the CLI persistence boundary

## Context

Sheg exposed the durable SQLite run service through MCP while its CLI kept a second execution, checkpoint, recovery, and reporting lifecycle. This split made the same product request behave differently depending on the entrypoint and duplicated accounting and failure behavior.

## Options considered

- Keep independent entrypoint lifecycles. This preserves the old file workflow but requires duplicated execution and persistence contracts.
- Retire the CLI. This removes duplication but loses a useful scriptable entrypoint.
- Use the CLI and MCP as adapters over one durable application service, keeping manifest trace and preflight as diagnostics and old file records as read-only historical input.

## Decision

The CLI and MCP use the same request contracts, run service, provider factory, detached worker, SQLite datastore, attempt accounting, and recovery path. Entrypoints may differ in argument decoding and result formatting, but not in durable run behavior. The CLI keeps keyless manifest `trace` and `preflight` diagnostics. Pre-release file-backed checkpoints remain available only through read-only historical reporting; they are not imported, started, resumed, cancelled, or mutated by the current run service.

## Consequences

An agent can switch between CLI and MCP while retaining the same run identities and evidence. Current requests have one durable lifecycle and one storage location. Pre-release file runs cannot continue through the current service. Historical reads may upcast older checkpoint shapes in memory but preserve the source bytes.
