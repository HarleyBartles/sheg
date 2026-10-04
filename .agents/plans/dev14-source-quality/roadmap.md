# Shared Sheg runtime and source quality

**Goal:** Deliver the approved source interrogation findings in PR #25 as `0.3.0-dev.14`, including one application system behind CLI and MCP entrypoints.

**Design authority:** The user approved applying the develop source audit in this PR, explicitly rejected separate CLI/MCP execution systems, and approved dev.14. The audit examined every source file at develop `1c5ba64c573e321eb32dcae71fa93cc28a9136dd`; its analysis is off-repository at `Z:/_agent-scratch/sheg/src-audit-dev13/review.md`. This roadmap carries executable scope rather than retaining the review as a receipt.

**Workspace:** Reuse `Z:/_agent-worktrees/sheg/codex/v0.3.0-docs-audit`, branch `codex/v0.3.0-docs-audit`, PR #25 into develop. Existing documentation changes remain part of the PR. Execute sequentially; do not update the release branch or publish a tag.

## Invariants

- CLI and MCP use the same durable admission, execution, storage, accounting, querying, cancellation and recovery services. Interface-specific input loading, validation and output formatting belong in entrypoints.
- Preserve historical SQLite records, compiler identities, original packets, answer custody, uncertain-call accounting and migration guarantees. No rewriting evidence to make refactoring easier.
- Keep provider admission before credential access and dispatch. Never return secrets or raw provider bodies in failures. No paid inference is needed for this work.
- Tests are supporting behavior verification for changes, not a separate test-tree audit. No assertion-only change detectors, weakened flaky checks, skill behavior runs in CI, or committed test results.
- Generated files derive from canonical source. Package version has one authored owner in package.json. Regenerate the self-contained package and verify Git/ZIP parity before publication.
- Planning artifacts remain in develop under existing residency rules and do not enter main. No permanent audit checklist or development receipt belongs in shipped guidance.

## Sequence

| # | Scope | Status | Plan |
| --- | --- | --- | --- |
| 1 | Typed contracts, failure evidence and evidence cursor integrity | ready | [01-contract-correctness.md](01-contract-correctness.md) |
| 2 | Shared runtime composition and CLI adapter; retire separate execution and reporting lifecycle | pending | Write against Plan 1 |
| 3 | Persistence/query ownership, bounded worker reads, shared routing/material/provider wire semantics and concise invariants | pending | Write against Plan 2 |
| 4 | Source-wide reconciliation, documentation, dev.14 generation, review and publication of the completed PR | pending | Write against Plan 3 |

## Acceptance scope for remaining plans

Plan 2 replaces CLI RunManager/checkpoint execution with the durable RunService and common runtime composition. CLI accepts current direct request JSON, submission IDs and durable run IDs, including follow-ons. It offers the same query/recall/cancel/resume semantics and datastore location as MCP. Keep deterministic trace/preflight only through shared domain behavior with a concrete diagnostic interface. Old file-backed evidence must remain readable through an explicitly separate historical import/read boundary if needed; do not silently create new runs or claim legacy checkpoints can use SQLite recovery. Remove obsolete lifecycle code once supported historical access is accounted for. Report comparisons use normalized typed meanings, including rubric, criteria and history. Lock crash recovery is either corrected safely or removed with its unreachable legacy owner.

Plan 3 extracts cohesive SQLite schema/migration/recovery and query construction/decoding responsibilities while keeping evidence settlement and respondent advancement atomic. Define application-owned storage ports. Centralize current schema identity, pure material merging, typed answer projection, route matching and provider configuration/wire contracts. Replace whole-journey worker rereads with a bounded current-turn read. Shorten query write transactions without changing consistent evidence semantics. Remove product-unreachable draft packet batching/preview branches unless the diagnostic entrypoint establishes a supported use. Preserve pinned vendor code, attribution and authored shipped catalogue assets. Add comments where accounting, leases, fingerprints, fixed-point packet sizing and migration ordering depend on non-obvious invariants. Do not add a general framework, arbitrary file-size thresholds or an omnibus constants module.

Plan 4 reconciles every audit item against the final source. Speculative performance concerns need measurement or a clearly bounded structural correction, not an invented defect. Consolidate typed failures/configuration/routing/projections where duplication risks behavior drift; leave deliberate traversal and protocol differences explicit. Consider type-aware promise/exhaustiveness lint only if it strengthens actual first-party behavior without introducing mechanical cleanup. Ensure guidance describes supported entrypoints truthfully and concisely. Run focused behavior checks and npm run verify, regenerate distribution outputs, obtain a fresh whole-branch review, fix meaningful findings, then push and update PR #25 around its full final scope.
