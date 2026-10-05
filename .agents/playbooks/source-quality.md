# Source quality

## Applicability

Use when implementing or reviewing changes to Sheg source, tests, generated runtime output, persisted contracts, providers, or entrypoints.

## Method

Trace each changed behavior from its public entrypoint to its semantic owner and behavior coverage. Keep domain rules in `src/domain/`, orchestration in `src/application/`, provider wire behavior in `src/providers/`, and persistence mechanics in `src/infrastructure/`. Inspect callers and existing tests before changing an interface or removing code. Validate external and persisted input at the boundary that owns its interpretation.

An Unslop profile is a repository-owned corrective guide for an observed pattern of agent mistakes. Sheg stores these guides and their supporting observations in `.agents/unslop/`. Each guide describes the mistake to recognize, the corrective action, where it applies, and the exceptions that prevent applying it too broadly.

Complete the following checks before editing. During review, repeat them against the final diff and its callers.

1. For provider single/batch execution, validation, retries, or CLI/MCP dispatch, read [boundary drift](../unslop/boundary-drift.md). Trace each affected entry path to its validation and execution owner. Locate provider identity checks, attempt accounting, retry handling, and failure scope where affected. Identify what must stay shared and which wire decoders or public result contracts must stay separate.
2. For domain schemas, storage codecs and repositories, workers, reports, or material and journey rules, read [single rule owner and operation-local reuse](../unslop/single-owner-and-reuse.md). Locate the authoritative owner of each affected rule and the boundary that decodes stored input. Inspect affected operations for repeated reads or computations, and identify values already available for reuse. Locate transaction boundaries and provider calls where affected; check snapshot and rollback requirements before changing them.
3. Read both guides when both triggers apply. Before editing, state the concrete findings in the working chat, naming the source files or symbols, the correction needed, and any separation justified by a guide's exceptions. If neither trigger applies, state why. Resolve unknown ownership or failure scope by inspecting code and callers before making the dependent change.

## Constraints

Preserve transaction atomicity, physical-call accounting, respondent-local recovery, frozen evidence, and the release compatibility policy. Keep persistence mutations within their transaction owner and bounded reads within named read owners. Retain distinct wire decoders, error scopes, and public result shapes. Generate runtime output from canonical source. Do not add tests that only detect source edits or duplicate implementation assertions.

## Verification

Add or extend behavior tests only for a demonstrated coverage gap. Run focused tests, typecheck, and the full `npm run verify` gate before publication. Rebuild and check generated parity when source or shipped guidance changes. For package changes, exercise the copied runtime and required assets independently of the checkout.

Before declaring the change ready, review the final diff against each triggered check above. In the review or PR handoff, identify the resulting owners and boundaries with source references, explain any retained duplication or separation, and report unresolved concerns. A statement that profiles were read or applied is insufficient. If these findings are missing, the reviewer must perform the checks before recommending readiness. Passing tests prove only the covered behavior and do not prove profile discovery or effectiveness. Keep these findings in the working chat or PR, not a repository receipt file.

## References and routing

Use the [implementing runbook](../runbooks/implementing.md) for execution and the [PR runbook](../runbooks/pr.md) for review and publication. Follow [boundary drift](../unslop/boundary-drift.md) and [single ownership and operation-local reuse](../unslop/single-owner-and-reuse.md) for applicable corrective guards. The [decision records](../../docs/decisions/README.md) own consequential architecture and compatibility choices; the [operating standards certification](../contracts/standards-certification.md) owns the compliance obligations.

## Maintenance

Revisit this method and its references when responsibility boundaries, validation commands, package ownership, or compatibility policy change. When distinct evidence matches a profile, update that profile with a durable reference and assess whether the guard was reachable, followed, and useful; unknown effect stays unknown. Review the playbook's category, usefulness, routes, and certification whenever it changes.
