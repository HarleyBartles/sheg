# ADR-0001: Keep ADRs in the repository root

- Status: Superseded by [ADR-0006](0006-store-adrs-in-docs-decisions.md)
- Date: 2026-09-27
- Supersedes: None

## Context

This project is new and its architecture is still being established. Future
contributors need to understand why its contracts and technical direction were
chosen. The decisions should be available with the source, versioned with the
implementation, and easy to find without access to a separate service.

Common guidance uses either a `docs/decisions` path, as in MADR, or a dedicated
directory at the repository root. The format does not require a particular location.

## Options considered

- Keep records in a hosted wiki or linked documentation service. This can help
  non-code stakeholders, but adds a separate source of truth and may not be
  available to a developer browsing a checkout.
- Put records under `docs/decisions`. This is a well-established convention
  and groups decisions under general documentation.
- Put records in a dedicated root directory. This makes the decision log visible
  immediately at the repository root and keeps it distinct from generated or
  workflow-specific planning material.

## Decision

At acceptance, store Markdown ADRs in a dedicated directory at the repository root.
Track them in Git and maintain a short index. This location decision was
superseded by ADR-0006; the original rationale for keeping the log in the
repository remains in effect.

## Consequences

Future contributors can read the rationale from a checkout without a separate
service. The records evolve with the code and remain reviewable in pull
requests. Keep the index current and add a superseding record when a durable
decision changes. A wiki can link to these records, but does not own their
canonical text.

## References

- [MADR: Applying MADR to your project](https://adr.github.io/madr/)
- [ADR GitHub: How to start using ADRs with Git](https://github.com/architecture-decision-record/architecture-decision-record)
