# Repository agent orientation

For contribution stage routing, follow the [Sheg runbook and playbook
policy](.agents/doctrine/repo-runbook-policy.md), then use the matching
lifecycle runbook and any routed playbooks. Feature work starts from `develop`
and feature PRs target `develop`.

## Repository surfaces

- `src/domain/` owns study, respondent, decision, and journey contracts and behavior.
- `src/application/`, `src/providers/`, `src/infrastructure/`, and
  `src/entrypoints/` are the planned homes for orchestration, model adapters,
  persistence/runtime support, and CLI/MCP boundaries as those surfaces are
  implemented. Keep responsibility and ownership clear; avoid catch-all
  modules.
- `test/` is the separate Node test tree. Keep behavior tests grouped by the
  responsibility they exercise.
- `docs/` holds verified provider wire notes and operational details; check
  these before changing an external adapter.
- `skills/stimulus-response-polling/` is the user-facing Codex skill. Plugin
  metadata and packaged runtime are at the repository root when introduced.
- `docs/decisions/README.md` indexes durable architecture decisions;
  `docs/decisions/template.md` is the starting point for a new record.

## Decision-record hygiene

Record consequential architecture, contract, distribution, or operational
choices as one decision per ADR. Update the index in the same change. When an
accepted decision changes, add a superseding ADR rather than rewriting its
history. Routine implementation details belong in code or the active plan.

## Local verification

Run `npm run verify` before publishing changes. The tracked
`.githooks/pre-commit` runs that command against the staged snapshot with a
clean dependency install; hosted CI runs the same command on the PR merge
commit.
