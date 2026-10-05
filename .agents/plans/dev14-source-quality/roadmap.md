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
| 1 | Typed contracts, failure evidence and evidence cursor integrity | complete | [01-contract-correctness.md](01-contract-correctness.md) |
| 2 | Shared runtime composition and CLI adapter; retire separate execution and reporting lifecycle | complete | [02-shared-entrypoints.md](02-shared-entrypoints.md) |
| 3 | Consolidate concrete shared provider and journey rules without speculative performance rewrites | complete | [03-shared-rules.md](03-shared-rules.md) |
| 4 | Audit the full test tree and remove assertions that freeze inventories or prove only self-consistency | complete | [04-test-quality.md](04-test-quality.md) |
| 5 | Source-wide reconciliation, documentation, dev.14 generation, review and publication of the completed PR | in progress | [05-closeout.md](05-closeout.md) |

## Closeout scope

Plans 1-3 address the six concrete defects in the source assessment, unify durable CLI/MCP execution, retain read-only legacy reports, and consolidate the shared provider configuration, System One wire, and journey-route rules. Plan 4 removes brittle test inventories and self-consistency checks, and hardens child-process cleanup without weakening concurrency coverage.

The assessment also recommended broader decomposition of SQLite persistence and reporting, consumer-owned storage ports, shared typed answer projections and provider failure contracts, paired batch capabilities, and bounded worker reads. Those structural recommendations are not claimed as completed here. The query and initialization costs were not benchmarked, and a persistence rewrite would exceed this slice; keep them as future design work only if a concrete ownership or measured behavior need justifies it. Preserve transaction boundaries and historical bytes in any later change.

Plan 5 reconciles the implemented defects and these explicit deferrals against the final source, ensures guidance describes supported entrypoints truthfully, runs `npm run verify`, regenerates distribution outputs, obtains a fresh whole-branch review, fixes meaningful findings, and updates PR #25 around its full final scope.
