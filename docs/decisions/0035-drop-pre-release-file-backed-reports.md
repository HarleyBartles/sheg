# ADR-0035: Drop pre-release file-backed run reports

- Status: Accepted
- Date: 2026-10-05
- Supersedes: [ADR-0029](0029-share-the-durable-run-system-across-entrypoints.md) only for its pre-release file-backed report support decision; its shared CLI/MCP durable-run architecture remains accepted.

## Context

Before v0.3.0, the CLI could read and compare file-backed run checkpoints that predated the shared SQLite run service. Sheg has no external users before v0.3.0, and that release begins its first compatibility promise.

## Options considered

- Preserve report-only access to pre-release checkpoint formats, keeping checkpoint validation, in-memory upcasting, legacy fingerprints, CLI commands, and report aggregation.
- Remove that pre-release report path before v0.3.0, avoiding a compatibility burden for a private development format while preserving current durable runs and diagnostic commands.

## Decision

Do not support pre-release file-backed run archives in v0.3.0. Remove their reader, format upcasters, unique fingerprint helpers, report aggregation, and CLI report and comparison commands. Keep keyless manifest `trace` and `preflight`, and keep SQLite schema and payload compatibility under their separate decisions.

## Consequences

Pre-release archive files remain untouched on disk, but Sheg no longer opens or compares them. First release compatibility starts from the supported v0.3.0 SQLite baseline; no compatibility promise is made for development-only file-backed checkpoint formats.
