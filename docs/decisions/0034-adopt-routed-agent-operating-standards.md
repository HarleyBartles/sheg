# ADR-0034: Adopt routed agent operating standards

- Status: Accepted
- Date: 2026-10-05
- Supersedes: None

## Context

Sheg maintains contribution-stage runbooks, cross-stage playbooks, and recurring guidance for source-quality mistakes. Ambient skill availability alone does not establish which operating rules a repository follows, and an unread profile inventory would not prevent mistakes.

## Options considered

- Keep the current guidance without pinned definitions or explicit profile routing, which leaves its authority and upkeep unclear.
- Pin selected immutable standards, self-certify the repository-owned implementation, and route applicable profiles through source-quality guidance, which makes authority and maintenance obligations inspectable without adding a fixed book inventory.

## Decision

Adopt `unslop`, `playbook-composition`, and `runbook-composition` from the Agent Asset Marketplace at the immutable revision recorded in `.agents/contracts/operating-standards.json`. Maintain repository-owned certification, source-quality profiles, and lifecycle routing. Profiles describe applicable corrective behavior and false-positive boundaries; agents record distinct evidence and assess reach and effectiveness without assuming either.

## Consequences

Root `AGENTS.md` routes to the subscription, certification, and contribution stages. Implementing and pull request runbooks route source changes through the source-quality playbook, which links applicable profiles. The repository gate checks pinned metadata and local route integrity; human review assesses semantic usefulness and observed profile effectiveness. Marketplace updates require an explicit pin change and reassessment.
