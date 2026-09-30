# ADR-0016: Bound provider attempts without spend accounting

- Status: Accepted
- Date: 2026-09-30
- Supersedes: Jev spend-ceiling decision in [ADR-0011](0011-deterministic-study-preview-and-packet-sizing.md)

## Context

Provider billing varies by the account behind a user-supplied key. Sheg needs
to prevent runaway studies, but a configured amount is not a reliable spend
ceiling and Sheg is not an accounting product.

## Options considered

- Enforce estimated USD caps and require reconciliation of uncertain charges.
- Remove runaway-call protection along with spend enforcement.
- Bound physical provider attempts and leave account-level billing to the
  provider, while retaining optional per-decision cost evidence.

## Decision

Use `maxCalls` as the single run-wide limit for physical provider attempts,
including retries. Consume attempts observed before failures and conservatively
consume interrupted reservations on recovery. Do not block resume for unknown
charges or expose spend caps, cumulative cost, or reconciliation. A decision
may carry provider-reported cost or a published-rate estimate when available;
reports preserve that evidence per decision without totaling it.

## Consequences

Sheg prevents runaway calls without claiming to cap a user's bill. Exact usage
remains available in the user's provider dashboard. Reports can present
heterogeneous optional cost evidence without asserting account-level totals.
