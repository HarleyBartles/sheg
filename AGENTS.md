# Repository agent orientation

For contribution stage routing, follow the [Sheg runbook and playbook policy](.agents/doctrine/repo-runbook-policy.md), then use the matching lifecycle runbook and any routed playbooks. Feature work starts from `develop` and feature PRs target `develop`.

## Repository surfaces

- `src/domain/` owns study, respondent, decision, and journey contracts and behavior.
- `src/application/`, `src/providers/`, `src/infrastructure/`, and `src/entrypoints/` own orchestration, model adapters, persistence/runtime support, and CLI/MCP boundaries respectively.
- `test/` holds Node behavior tests grouped by responsibility.
- `docs/` holds provider wire notes and operational details; check these before changing an external adapter.
- `skills/` is canonical user-facing guidance. `dist/` and `plugins/sheg/` are generated runtime and distribution outputs.
- [.agents/doctrine/skill-behavior-testing.md](.agents/doctrine/skill-behavior-testing.md) defines the testing posture for skills and their scenario fixtures.
- [docs/decisions/README.md](docs/decisions/README.md) indexes durable architecture decisions; use its linked template for new records.

## Decision-record hygiene

Record consequential architecture, contract, distribution, or operational choices as one decision per ADR. Update the index in the same change. When an accepted decision changes, add a superseding ADR rather than rewriting its history. Routine implementation details belong in code or the active plan.

## Planning artifact residency

Follow the [release guide's planning residency rule](docs/guides/releases.md#branches-and-promotion): planning artifacts stay on `develop` and do not enter `main`.

## Local verification

Run `npm run verify` before publishing changes. The tracked `.githooks/pre-commit` runs that command against the staged snapshot with a clean dependency install; hosted CI runs the same command on the PR merge commit.
