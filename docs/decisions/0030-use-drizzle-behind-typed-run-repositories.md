# ADR-0030: Use Drizzle behind typed run repositories

- Status: Accepted
- Date: 2026-10-05

## Context

The SQLite adapter had become a large application-facing store that combined queries, writes, row mapping, and lifecycle reconciliation. Callers could not see which operations mutated state, while inline SQL and row assertions allowed query details to drift across features.

## Options considered

- Keep the combined store and improve local typing. This leaves callers coupled to one broad persistence surface and does not make read-side effects visible.
- Replace the adapter with an ORM used directly by application services. This would expose ORM-specific behavior and let callers rebuild projections inconsistently.
- Use Drizzle inside infrastructure-owned read and command repositories. Named repository methods own projections, runtime decoding, transaction boundaries, and the ORM's edge cases while application services depend on declared shapes.

## Decision

Use the exactly pinned Drizzle release tested for Sheg's Node 24 `node:sqlite` runtime behind application-facing `RunReadRepository` and `RunCommandRepository` interfaces. The repositories share one persistence owner and connection. Read methods are side-effect free; services explicitly coordinate reconciliation before current-state reads. Commands validate preconditions and mutate under an immediate transaction. Provider I/O remains outside database transactions. Complex SQL stays inside named infrastructure repository operations and must decode its results before returning them.

## Consequences

Callers use stable domain-oriented operations rather than table layouts or ORM expressions. Infrastructure remains responsible for synchronous transactions, runtime validation, and controlled SQL fragments. The ORM is justified only where its typed schema and query/write APIs are used; it is not a reason to duplicate types or add an abstraction without a repository contract.
