# Sheg Runbook and Playbook Policy

## Purpose

Runbooks own contribution stages. Playbooks own topical workflows that apply
across stages. This policy is Sheg-owned and describes how these documents
compose; each document remains useful on its own.

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

## Composition and capability selection

The implementing and pull request runbooks link to both topical playbooks. A
runbook or playbook may name required and optional capabilities in terms of
what they do, not a vendor, plugin, or skill identifier. Agents inspect the
capabilities available in their current harness and select a suitable provider.
If a required capability is unavailable, stop the dependent step and report
what is missing. If an optional capability is unavailable, continue and note
that limitation where it affects the result.

Capability notes describe behavior the workflow needs; they do not assert that
a particular tool or ambient extension is installed. Repository documents and
Git evidence remain the authority for Sheg-specific process and state.

## Adding a workflow

Add a runbook only for a lifecycle stage and a playbook only for a reusable
topic. Update this policy, link the topical playbook from each applicable stage
runbook, and link back to the stage roots from the playbook. Keep each workflow
focused and put durable project decisions in the decision records index.
