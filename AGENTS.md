# Repository agent orientation

For contribution stages, follow the [runbook and playbook policy](.agents/doctrine/repo-runbook-policy.md), then the [implementing runbook](.agents/runbooks/implementing.md) or [pull request runbook](.agents/runbooks/pr.md). Feature work starts from `develop` and targets `develop`.

The repository's pinned operating standards and self-certification are recorded in [.agents/contracts/operating-standards.json](.agents/contracts/operating-standards.json) and [.agents/contracts/standards-certification.md](.agents/contracts/standards-certification.md).

Run `npm run verify` before publishing changes. The tracked pre-commit hook runs it against the staged snapshot, and hosted CI runs it on the PR merge commit.
