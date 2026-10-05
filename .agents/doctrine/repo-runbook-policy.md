# Sheg Runbook and Playbook Policy

## Purpose

Runbooks own contribution stages. Playbooks own concerns that apply across stages. Sheg implements its pinned AOM subscriptions through this local policy and the [operating standards certification](../contracts/standards-certification.md). AOM defines the category and composition obligations; this policy defines the structure and review obligations for Sheg's documents.

## Lifecycle runbooks

| Stage | Path | Owns |
| --- | --- | --- |
| Implementing | `.agents/runbooks/implementing.md` | Branch setup, implementation, verification, and readiness for review |
| Pull request | `.agents/runbooks/pr.md` | PR preparation, evidence, review, and merge follow-through |

## Topical playbooks

| Concern | Path | Routed from |
| --- | --- | --- |
| Gitflow branches and releases | `.agents/playbooks/gitflow-branch-and-release.md` | Implementing and pull request |
| SemVer and version alignment | `.agents/playbooks/semver-version-alignment.md` | Implementing and pull request |
| Source quality | `.agents/playbooks/source-quality.md` | Implementing and pull request |

## Sheg playbook layout

Every playbook in `.agents/playbooks/` uses one concern title and the following sections in order. Each section contains actionable concern-specific content; omit empty capability inventories and placeholder text.

| Section | Required content |
| --- | --- |
| Applicability | The concrete triggers and surfaces where the concern applies. |
| Method | How to perform the concern, including the capabilities needed and the decisions or actions they support. |
| Constraints | The invariants, scope boundaries, and prohibited actions that govern the method. |
| Verification | The checks and evidence needed to assess the result, with explicit limits on what those checks prove. |
| References and routing | Links to authoritative shared policy and applicable lifecycle runbooks, explaining their relevance; link related playbooks or profiles where needed. |
| Maintenance | The changes that require revisiting this playbook, its references, routes, and certification. |

This is a Sheg-owned layout, not a universal AOM template. A new concern must fit this layout or revise this policy and certification in the same change with a concrete justification. A reviewer must assess whether the method actually lets an agent perform the concern and whether the constraints and evidence match current repository behavior. Headings alone cannot establish usefulness.

## Composition and capability selection

Runbooks link to applicable playbooks at the relevant contribution stages. Playbooks link back to those stage roots so an agent entering through a concern can find the lifecycle procedure. This local navigation requirement applies only to relevant stages; it does not require all-to-all links.

Describe capabilities by the work they perform. Agents inspect their harness and select a suitable provider. Identify environment-provided capabilities as such; do not imply that a personal ambient plugin is available to every clone. Reference repository-owned skills by link and declared plugin skills by plugin-qualified name when a workflow actually needs them. Stop the dependent step if a required capability is unavailable; continue without optional capabilities and report any resulting limitation.

Keep shared topical knowledge at one owner and link it from consumers. The pinned subscriptions are in [operating-standards.json](../contracts/operating-standards.json). The [source-quality method](../playbooks/source-quality.md#method) defines Unslop profiles, identifies their canonical location, and links each guide beside its applicability. Introduce concern-specific terms before requiring an agent to act on them; a reference list alone does not explain how to select a guide.

## Documentation audiences and ownership

Choose documentation by its intended reader and task. Root `docs/` serves humans using, developing, installing, or trying to understand Sheg; technical depth does not make a document agent-facing. `.agents/` owns instructions for agents working in this repository. Agents using Sheg receive instructions through canonical `skills/`, usually skill references, which the build ships in the plugin. Root README provides human-facing repository orientation and links to the appropriate human documentation.

Live guides and instructions state current behavior and obligations. Do not add change narratives such as "before dev.N", "dev.N now", completion announcements, test results, or implementation receipts. Git history and PRs retain development history. ADRs retain consequential decision context; Unslop observations retain the distinct mistake evidence needed to assess guards. Those purpose-specific records do not justify duplicating history in live guidance.

## Adding or changing a workflow

Add a runbook only for a lifecycle stage and a playbook only for a reusable concern. Update this policy's inventory, link each concern from its applicable stage runbooks, and add the corresponding stage links in the playbook. Follow the local layout, validate references and routes with `npm run guidance:check`, and maintain the certification's structural and substantive assessment. Put consequential project decisions in the [decision records index](../../docs/decisions/README.md).
