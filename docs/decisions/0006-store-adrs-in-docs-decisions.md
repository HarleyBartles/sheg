# ADR-0006: Store ADRs in `docs/decisions`

- Status: Accepted
- Date: 2026-09-27
- Supersedes: [ADR-0001](0001-keep-adrs-in-the-repository.md), location only

## Context

The repository now has a root `docs/` directory for verified technical and
operational documentation. Keeping architecture decisions in a separate root
directory splits related documentation surfaces and adds a special case to
the repository map.

## Options considered

- Keep ADRs in their former dedicated root directory.
- Store ADRs in a linked external wiki, which separates durable project
  context from the code and checkout.
- Store ADRs in `docs/decisions`, alongside the repository's other documentation.

## Decision

Store the ADR index, template, and numbered records in `docs/decisions/`.
Keep them versioned with the implementation and update their relative links
when records move. ADR-0001's decision to keep records in the repository remains
in force; this record supersedes only its location choice.

## Consequences

Repository guidance and future ADRs point to `docs/decisions/`. The log stays
available in a checkout and reviewable alongside code, while technical guides
remain grouped under the single root documentation directory.
