# ADR-0018: Store durable runs in local SQLite

- Status: Accepted
- Date: 2026-10-01
- Supersedes: None

## Context

An agent needs to close its MCP connection and discover an accepted request,
frozen respondent inputs, attempt accounting and typed answers from a later
connection. Sheg is installed and runs in the user's environment, and the first
release does not promise cross-host storage.

## Options considered

- Continue with per-run JSON checkpoint files. This fits the existing journey
  runner but makes indexed discovery, transactional identity and related
  respondent/evaluation/attempt records harder to maintain safely.
- Use a hosted database. This could share records across hosts, but adds service
  operation, credentials and an availability dependency without a product need.
- Use SQLite under the configured local application data root. This is durable,
  transactional and available in the supported Node runtime without another
  native or network dependency.

## Decision

Use Node's built-in synchronous SQLite API as the authoritative local run store.
Resolve its root from `SHEG_DATA_DIR`, then `PLUGIN_DATA`, then the platform's
application data directory. Commit the accepted request, frozen evaluations,
attempt reservations and answer updates in short transactions. Enable foreign
keys, WAL, full synchronous writes and a bounded busy timeout. Expose no raw
database path or file operations through the MCP.

Persist and check a current schema version. Below v1, unsupported data receives
clear export/reset guidance; Sheg does not promise a migration path. The store
is local to one configured data root and does not claim network-share or
cross-host coordination.

## Consequences

Users can retain and query run records across MCP connections without creating
study files or depending on the caller's working directory. Sheg owns relational
integrity, attempt accounting and later storage maintenance. The existing
file-backed journey CLI remains separate until its just-in-time integration
plan moves authored journeys onto this store. A later lifecycle slice must add
explicit resume and controlled deletion without weakening the transaction and
foreign-key guarantees.
